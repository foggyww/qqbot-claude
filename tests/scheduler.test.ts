import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerImpl } from "../src/scheduler/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAccountingRequestContext, withAccountingRequestContext } from "../src/core/accounting-request-context.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SchedulerImpl lifecycle", () => {
  it("does not grant timers the write authority of the QQ command that created them", async () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerImpl();
    const callback = vi.fn(async () => { expect(getAccountingRequestContext()).toBeUndefined(); });
    await withAccountingRequestContext({ senderQq: 123, messageId: "456" }, async () => {
      scheduler.addJob(callback, { type: "interval", minutes: 1 }, "isolated");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAccountingRequestContext()).toBeDefined();
    });
    expect(callback).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
  it.each(["*/-1 * * * *", "*/0 * * * *", "*/foo * * * *", "60 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 7", "3-1 * * * *", "1foo * * * *", "1,,2 * * * *", "0 0 30 2 *"])("rejects invalid or impossible cron %s", (expression) => {
    vi.useFakeTimers();
    const scheduler = new SchedulerImpl();
    expect(() => scheduler.addJob(async () => {}, { type: "cron", expression }, "bad")).toThrow();
    expect(scheduler.getJob("bad")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, -1, Infinity, NaN, 0.000001, 1e10])("rejects unsafe interval %s", (minutes) => {
    const scheduler = new SchedulerImpl();
    expect(() => scheduler.addJob(async () => {}, { type: "interval", minutes }, "bad")).toThrow();
  });
  it("isolates synchronous errors and prevents overlapping intervals", async () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerImpl();
    let finish!: () => void;
    const pending = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const fail = vi.fn(() => { throw new Error("sync error"); });
    scheduler.addJob(pending, { type: "interval", minutes: 1 }, "pending");
    scheduler.addJob(fail, { type: "interval", minutes: 1 }, "fail");
    await vi.advanceTimersByTimeAsync(180000);
    expect(pending).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledTimes(3);
    finish();
    await vi.advanceTimersByTimeAsync(60000);
    expect(pending).toHaveBeenCalledTimes(2);
    scheduler.stop();
    finish();
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not resurrect stopped or replaced cron jobs when an old execution completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const scheduler = new SchedulerImpl();
    let finish!: () => void;
    scheduler.addJob(() => new Promise<void>((resolve) => { finish = resolve; }), { type: "cron", expression: "* * * * *" }, "cron");
    await vi.advanceTimersByTimeAsync(60000);
    scheduler.addJob(async () => {}, { type: "interval", minutes: 2 }, "cron");
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits in bounded chunks for long cron delays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const scheduler = new SchedulerImpl();
    const fn = vi.fn(async () => {});
    scheduler.addJob(fn, { type: "cron", expression: "0 0 1 1 *" }, "yearly");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(new Date("2027-01-01T00:00:00Z").getTime() - Date.now());
    expect(fn).toHaveBeenCalledOnce();
    scheduler.stop();
  });
  it("isolates rejected cron promises and schedules the next run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const scheduler = new SchedulerImpl();
    const fn = vi.fn(async () => { throw new Error("async failure"); });
    scheduler.addJob(fn, { type: "cron", expression: "* * * * *" }, "failing");
    await vi.advanceTimersByTimeAsync(120000);
    expect(fn).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
  it("ignores malformed files and recovers valid tasks among invalid entries", () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
    const file = path.join(dir, ".schedules.json");
    const scheduler = new SchedulerImpl();
    try {
      for (const value of ["{", "{}", "null"]) {
        fs.writeFileSync(file, value);
        expect(() => scheduler.reloadFrom(dir)).not.toThrow();
      }
      fs.writeFileSync(file, JSON.stringify([null, {}, { name: "bad", cron: "*/-1 * * * *", msg: "test" }, { name: "disabled", cron: "* * * * *", msg: "test", enabled: false }, { name: "good", cron: "* * * * *", msg: "test" }]));
      scheduler.reloadFrom(dir);
      expect(scheduler.getJob(`${dir}::bad`)).toBeNull();
      expect(scheduler.getJob(`${dir}::disabled`)).toBeNull();
      expect(scheduler.getJob(`${dir}::good`)).not.toBeNull();
    } finally {
      scheduler.stop();
      fs.rmSync(dir, { recursive: true });
    }
  });
  it("removes all interval and cron jobs when stopped", () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerImpl();
    scheduler.addJob(async () => {}, { type: "interval", minutes: 1 }, "interval");
    scheduler.addJob(async () => {}, { type: "cron", expression: "0 12 * * 0" }, "cron");

    scheduler.stop();

    expect(scheduler.getJob("interval")).toBeNull();
    expect(scheduler.getJob("cron")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
