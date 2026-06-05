/**
 * 默认对话 —— 根据当前模式选择 claude/root 执行
 *
 * 对应 Python: src/qqbot/commands/builtin/converse.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { askClaude, askClaudeRoot } from "../../ai/claude-code.js";
import { getConfig } from "../../core/config.js";
import { loadPrompt } from "../../prompt.js";

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

  if (store.isRootMode(sessionDir)) {
    const sessionId = store.getSessionId(sessionDir);
    return askClaudeRoot(msg, sessionDir, sessionId, undefined, model, effort);
  }

  msg = `${ctx.senderNick || "未知"}（qq=${ctx.senderQq || 0}）说：${msg}`;

  // Normal (non-root) mode: build system prompt
  const replyType = ctx.replyType;
  const replyId = ctx.replyId;
  const cmd = `qqmsg ${replyType} ${replyId}`;

  const info = getBotInfo(ctx);
  const botDesc = `你的QQ昵称是${info.nick}，QQ号${info.qq}。\n\n`;
  const readonly = loadPrompt("readonly");

  let chat: string;

  if (replyType === "group") {
    const target = `当前是群聊，群号${replyId}。send_message 的 type 必须填 group，target 填 ${replyId}。\n`;
    const groupPrompt = loadPrompt("group")
      .replace(/\{cmd\}/g, cmd)
      .replace(/\{master_qq\}/g, String(getConfig().prompt.masterQq));
    chat = botDesc + target + readonly + "\n\n" + groupPrompt;
  } else {
    const target = `当前是私聊，对方QQ${replyId}。send_message 的 type 必须填 private，target 填 ${replyId}。\n`;
    const conversePrompt = loadPrompt("converse")
      .replace(/\{cmd\}/g, cmd)
      .replace(/\{master_qq\}/g, String(getConfig().prompt.masterQq));
    chat = botDesc + target + readonly + "\n\n" + conversePrompt;
  }

  const sessionId = store.getSessionId(sessionDir);
  return askClaude(msg, sessionDir, sessionId, chat, model, effort);
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
