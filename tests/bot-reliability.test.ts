import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BotConfig, MessageContext, QQAdapter, SchedulerRef, SessionStore } from "../src/core/types.js";
import { getAccountingRequestContext } from "../src/core/accounting-request-context.js";
import { McpHost } from "../src/mcp/host.js";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../src/core/router.js", () => ({
  dispatchMessage: dispatch, setSessionStore: vi.fn(), registerCommand: vi.fn(),
  unregisterCommand: vi.fn(), unregisterDefaultCommand: vi.fn(),
}));
import { Bot } from "../src/core/bot.js";

function createBot(): Bot {
  const adapter = { sendPrivateMsg: vi.fn(), sendGroupMsg: vi.fn(), onMessage: vi.fn(), start: vi.fn(), stop: vi.fn() } as unknown as QQAdapter;
  const bot = new Bot(adapter, {} as SessionStore, { stop: vi.fn() } as unknown as SchedulerRef);
  vi.spyOn(bot.pluginSystem, "onMessage").mockResolvedValue(undefined);
  return bot;
}

function context(messageId: number): MessageContext {
  return {
    sessionKey: "private_123", replyType: "private", replyId: 123,
    senderNick: "test", senderQq: 123, botQq: 999,
    sessionStore: {} as SessionStore,
    rawEvent: {
      self_id: 999, message_type: "private", message_id: messageId,
      user_id: 123, sender: { user_id: 123, nickname: "test" }, raw_message: "test", message: "test",
    },
  };
}

function handle(bot: Bot, ctx: MessageContext): Promise<void> {
  return (bot as unknown as { handleIncomingMessage(ctx: MessageContext): Promise<void> }).handleIncomingMessage(ctx);
}

beforeEach(() => { dispatch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("Bot message reliability", () => {
  it("starts tools before connecting QQ and rolls back a failed startup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-startup-"));
    const bot = createBot();
    bot.config = { qq: { account: 999, nickname: "test" }, paths: { sessionsDir: dir } } as BotConfig;
    const order: string[] = [];
    const stopHost = vi.spyOn(McpHost.prototype, "stop").mockResolvedValue(undefined);
    vi.spyOn(McpHost.prototype, "start").mockImplementation(async () => { order.push("mcp"); });
    vi.mocked(bot.adapter.start).mockImplementation(async () => { order.push("qq"); throw new Error("synthetic connection failure"); });
    try {
      await expect(bot.start()).rejects.toThrow("synthetic connection failure");
      expect(order).toEqual(["mcp", "qq"]);
      expect(stopHost).toHaveBeenCalledTimes(1);
      expect(bot.adapter.stop).toHaveBeenCalledTimes(1);
      expect(bot.scheduler.stop).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("deduplicates in-flight and completed events before plugins or AI run", async () => {
    const bot = createBot();
    let release!: () => void;
    dispatch.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return null; });
    const first = handle(bot, context(1));
    await Promise.resolve();
    await handle(bot, context(1));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(bot.pluginSystem.onMessage).toHaveBeenCalledTimes(1);
    release(); await first;
    await handle(bot, context(1));
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockResolvedValue(null);
    await handle(bot, context(2));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("binds a real message context and isolates failures without leaking metadata", async () => {
    const bot = createBot();
    vi.spyOn(bot.logger, "error").mockImplementation(() => {});
    dispatch.mockImplementation(async () => {
      expect(getAccountingRequestContext()).toEqual({ senderQq: 123, messageId: "3" });
      throw new Error("test failure");
    });
    await expect(handle(bot, context(3))).resolves.toBeUndefined();
    expect(getAccountingRequestContext()).toBeUndefined();
    await handle(bot, context(3));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("drops missing message identity instead of assigning a shared zero key", async () => {
    const bot = createBot();
    vi.spyOn(bot.logger, "warn").mockImplementation(() => {});
    const ctx = context(4);
    delete (ctx.rawEvent as Record<string, unknown>).message_id;
    await handle(bot, ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(bot.pluginSystem.onMessage).not.toHaveBeenCalled();
  });
});
