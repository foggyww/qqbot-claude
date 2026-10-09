/**
 * 默认对话 —— 根据当前模式选择 claude/root 执行
 *
 * 对应 Python: src/qqbot/commands/builtin/converse.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { askClaude, askClaudeRoot } from "../../ai/claude-code.js";
import { getConfig } from "../../core/config.js";
import { composePrompt } from "../../prompt.js";

// ---------------------------------------------------------------------------
// Bot info cache
// ---------------------------------------------------------------------------

let _botInfo: { nick: string; qq: number } | null = null;

function getBotInfo(ctx: MessageContext): { nick: string; qq: number } {
  if (!_botInfo) {
    const config = getConfig();
    _botInfo = {
      nick: ctx.botNick || "QQBot",
      qq: ctx.botQq || config.qq.account,
    };
  }
  return _botInfo;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  msg: string,
  sessionDir: string,
  ctx: MessageContext,
): Promise<string> {
  const store = ctx.sessionStore;
  const model = store.loadModel(sessionDir);
  const effort = store.loadEffort(sessionDir);

  const rawEvent = ctx.rawEvent && typeof ctx.rawEvent === "object"
    ? ctx.rawEvent as Record<string, unknown>
    : {};
  const messageId = typeof rawEvent.message_id === "number" || typeof rawEvent.message_id === "string"
    ? String(rawEvent.message_id)
    : "unknown";
  msg = `${ctx.senderNick || "未知"}（qq=${ctx.senderQq || 0}，message_id=${messageId}）说：${msg}`;
  const requestContext = messageId !== "unknown" && Number.isSafeInteger(ctx.senderQq) && ctx.senderQq > 0
    ? { senderQq: ctx.senderQq, messageId }
    : undefined;

  if (store.isRootMode(sessionDir)) {
    const sessionId = store.getSessionId(sessionDir);
    return askClaudeRoot(msg, sessionDir, sessionId, undefined, model, effort, undefined, undefined, requestContext);
  }

  // Normal (non-root) mode: build system prompt
  const replyType = ctx.replyType;
  const replyId = ctx.replyId;

  const info = getBotInfo(ctx);
  const chat = composePrompt({
    preset: replyType === "group" ? "converse-group" : "converse-private",
    variables: {
      bot_nick: info.nick,
      bot_qq: info.qq,
      master_qq: getConfig().prompt.masterQq,
      reply_id: replyId,
    },
  });

  const sessionId = store.getSessionId(sessionDir);
  return askClaude(msg, sessionDir, sessionId, chat, model, effort, undefined, requestContext);
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "converse",
    description: "默认对话",
    isDefault: true,
    minLevel: 1,
    handler: handle,
  },
];

export default class ConversePlugin implements Plugin {
  name = "converse";
  version = "1.0.0";
  description = "默认对话 —— AI 回复";
  commands = COMMANDS;
}
