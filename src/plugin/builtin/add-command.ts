/**
 * /add-command 指令 —— AI 辅助添加新指令
 *
 * 对应 Python: src/qqbot/commands/builtin/add_command.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { askClaudeRoot, TimeoutError } from "../../ai/claude-code.js";
import { loadPrompt } from "../../prompt.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  msg: string,
  sessionDir: string,
  ctx: MessageContext,
): Promise<string> {
  if (!msg.trim()) {
    return [
      "用法: /add-command 描述你想要的指令",
      "例如: /add-command 加一个 /review 指令，level 2，用于代码审查",
    ].join("\n");
  }

  const store = ctx.sessionStore;
  const model = store.loadModel(sessionDir);
  const effort = store.loadEffort(sessionDir);
  const sessionId = store.getSessionId(sessionDir);
  const prompt = loadPrompt("add_command");

  try {
    return await askClaudeRoot(msg, sessionDir, sessionId, prompt || undefined, model, effort);
  } catch (err) {
    if (err instanceof TimeoutError) {
      return "Claude Code 处理超时，请重试";
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "add_command",
    description: "AI 辅助添加新指令",
    prefix: "/add-command",
    minLevel: 3,
    requireRoot: true,
    handler: handle,
  },
];

export default class AddCommandPlugin implements Plugin {
  name = "add-command";
  version = "1.0.0";
  description = "/add-command 指令 —— AI 辅助添加新指令";
  commands = COMMANDS;
}
