/**
 * /edit 指令 —— 允许写文件的对话
 *
 * 对应 Python: src/qqbot/commands/builtin/edit.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { askClaude, askClaudeRoot } from "../../ai/claude-code.js";
import { loadPrompt } from "../../prompt.js";

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
  const prompt = loadPrompt("edit") || undefined;

  if (store.isRootMode(sessionDir)) {
    const sessionId = store.getSessionId(sessionDir);
    return askClaudeRoot(msg, sessionDir, sessionId, prompt, model, effort);
  }

  const sessionId = store.getSessionId(sessionDir);
  return askClaude(msg, sessionDir, sessionId, prompt, model, effort);
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "edit",
    description: "允许写文件的对话",
    prefix: "/edit",
    minLevel: 2,
    handler: handle,
  },
];

export default class EditPlugin implements Plugin {
  name = "edit";
  version = "1.0.0";
  description = "/edit 指令 —— 允许写文件";
  commands = COMMANDS;
}
