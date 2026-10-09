import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageContext, SessionStore } from "../src/core/types.js";

const { askClaude, askClaudeRoot } = vi.hoisted(() => ({
  askClaude: vi.fn().mockResolvedValue("ok"),
  askClaudeRoot: vi.fn().mockResolvedValue("ok"),
}));

vi.mock("../src/ai/claude-code.js", () => ({ askClaude, askClaudeRoot }));
vi.mock("../src/core/config.js", () => ({
  getConfig: () => ({
    qq: { account: 999 },
    prompt: { masterQq: 1 },
  }),
}));
vi.mock("../src/prompt.js", () => ({ composePrompt: () => "system prompt" }));

import { handle } from "../src/plugin/builtin/converse.js";

function context(rootMode: boolean): MessageContext {
  const sessionStore: SessionStore = {
    loadModel: () => "model",
    saveModel: () => {},
    loadEffort: () => "medium",
    saveEffort: () => {},
    isRootMode: () => rootMode,
    setRootMode: () => {},
    setChatMode: () => {},
    getSessionId: () => "session-id",
  };
  return {
    sessionKey: "private_123",
    replyType: "private",
    replyId: 123,
    senderNick: "小明",
    senderQq: 123,
    rawEvent: { message_id: 456 },
    sessionStore,
    botQq: 999,
    botNick: "bot",
  };
}

describe("converse message metadata", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes a stable OneBot message id to the normal backend", async () => {
    await handle("记一笔 10 元奶茶", "/tmp/session", context(false));
    expect(askClaude).toHaveBeenCalledWith(
      "小明（qq=123，message_id=456）说：记一笔 10 元奶茶",
      "/tmp/session",
      "session-id",
      "system prompt",
      "model",
      "medium",
      undefined,
      { senderQq: 123, messageId: "456" },
    );
  });

  it("passes the same sender and message id metadata to the root backend", async () => {
    await handle("记一笔 10 元奶茶", "/tmp/session", context(true));
    expect(askClaudeRoot).toHaveBeenCalledWith(
      "小明（qq=123，message_id=456）说：记一笔 10 元奶茶",
      "/tmp/session",
      "session-id",
      undefined,
      "model",
      "medium",
      undefined,
      undefined,
      { senderQq: 123, messageId: "456" },
    );
  });
});
