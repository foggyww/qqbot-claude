import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatOneBotApiError, OneBotAdapter } from "../src/adapter/onebot.js";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  constructor() { FakeSocket.instances.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  message(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

describe("OneBot connection and input safety", () => {
  let adapter: OneBotAdapter;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    adapter = new OneBotAdapter("ws://localhost:3000");
  });
  afterEach(async () => {
    await adapter.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("reconnects after initial error without close and deduplicates error plus close", async () => {
    await adapter.start();
    const first = FakeSocket.instances[0];
    const staleClose = first.onclose!;
    const staleOpen = first.onopen!;
    const staleMessage = first.onmessage!;
    first.onerror?.();
    staleClose({ code: 1006 });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1];
    second.open();
    const handler = vi.fn(async () => {});
    adapter.onMessage(handler);
    staleOpen();
    staleClose({ code: 1006 });
    staleMessage({ data: JSON.stringify({ post_type: "message", message_type: "private", user_id: 12, self_id: 13, message_id: 14 }) });
    expect(handler).not.toHaveBeenCalled();
    const call = adapter.callApi("test", {});
    expect(second.send).toHaveBeenCalledOnce();
    const request = JSON.parse(second.send.mock.calls[0][0] as string) as { echo: string };
    second.message({ echo: request.echo, status: "ok", data: 42 });
    await expect(call).resolves.toBe(42);
  });
  it("times out a stalled connection and clears timers on stop", async () => {
    await adapter.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(FakeSocket.instances[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    await adapter.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(2);
    await expect(adapter.callApi("test", {})).rejects.toThrow("Adapter stopped");
  });
  it("rejects pending calls on disconnect and waiting calls on stop", async () => {
    await adapter.start();
    const ws = FakeSocket.instances[0];
    ws.open();
    const pending = adapter.callApi("pending", {});
    const pendingAssertion = expect(pending).rejects.toThrow("WebSocket error");
    ws.onerror?.();
    await pendingAssertion;
    const waiting = adapter.callApi("waiting", {});
    const waitingAssertion = expect(waiting).rejects.toThrow("Adapter stopped");
    await adapter.stop();
    await waitingAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("isolates object-valued primitive fields and settles malformed API errors", async () => {
    await adapter.start();
    const ws = FakeSocket.instances[0];
    ws.open();
    const handler = vi.fn(async () => {});
    adapter.onMessage(handler);
    const hostile = { toString: null, valueOf: null };
    const base = { post_type: "message", message_type: "private", user_id: 12, self_id: 13, message_id: 14 };
    for (const message of [
      { ...base, message_type: hostile },
      { ...base, sender: { nickname: hostile }, raw_message: "safe text" },
      { ...base, message: [{ type: hostile, data: {} }] },
      { ...base, message: hostile },
    ]) expect(() => ws.message(message)).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
    const pending = adapter.callApi("test", {});
    const check = expect(pending).rejects.toThrow("retcode=unknown");
    const request = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(() => ws.message({ echo: request.echo, status: "failed", retcode: hostile })).not.toThrow();
    await check;
    expect(vi.getTimerCount()).toBe(0);
    ws.message({ ...base, message_id: 15, raw_message: "still alive" });
    await Promise.resolve(); await Promise.resolve();
    expect(handler).toHaveBeenCalled();
  });
  it("isolates malformed JSON structures, identities and null segments", async () => {
    await adapter.start();
    const ws = FakeSocket.instances[0];
    ws.open();
    const handler = vi.fn(async () => {});
    adapter.onMessage(handler);
    for (const input of [null, [], 12, "str"]) expect(() => ws.message(input)).not.toThrow();
    const valid = { post_type: "message", message_type: "group", user_id: "12", self_id: 13, group_id: 15, message_id: -14, message: [null, 1, { type: "text", data: { text: "ok" } }] };
    for (const change of [{ user_id: "abc" }, { self_id: null }, { group_id: -1 }, { message_id: undefined }, { message_id: "Infinity" }, { user_id: 1.1 }]) {
      ws.message({ ...valid, ...change });
    }
    ws.message(valid);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ sessionKey: "group_15", senderQq: 12, rawEvent: { raw_message: "ok", message_id: -14 } });
  });
  it("isolates synchronous handlers and continues processing", async () => {
    await adapter.start();
    const ws = FakeSocket.instances[0];
    ws.open();
    const handler = vi.fn(() => { throw new Error("handler failed"); });
    adapter.onMessage(handler);
    const valid = { post_type: "message", message_type: "private", user_id: 12, self_id: 13, message_id: 14 };
    ws.message(valid);
    await vi.advanceTimersByTimeAsync(0);
    ws.message(valid);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("formatOneBotApiError", () => {
  it.each([
    ["msg", { retcode: 1200, msg: "请求失败" }, "OneBot API error: retcode=1200: 请求失败"],
    ["wording", { retcode: 1200, wording: "网络连接异常" }, "OneBot API error: retcode=1200: 网络连接异常"],
    ["message", { retcode: 1200, message: "账号已离线" }, "OneBot API error: retcode=1200: 账号已离线"],
  ])("includes a non-empty %s diagnostic", (_field, response, expected) => {
    expect(formatOneBotApiError(response)).toBe(expected);
  });

  it("ignores empty diagnostics and always includes retcode", () => {
    expect(formatOneBotApiError({ retcode: 1200, msg: " ", wording: "" }))
      .toBe("OneBot API error: retcode=1200");
  });

  it("keeps distinct diagnostics and removes duplicates", () => {
    expect(formatOneBotApiError({
      retcode: 1200,
      msg: "failed",
      wording: "网络连接异常",
      message: "网络连接异常",
    })).toBe("OneBot API error: retcode=1200: failed; 网络连接异常");
  });
});
