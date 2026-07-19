import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerImpl } from "../src/scheduler/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SchedulerImpl lifecycle", () => {
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
