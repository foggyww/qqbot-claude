/**
 * /chat 指令 —— 切回普通 claude 模式
 *
 * 对应 Python: src/qqbot/commands/builtin/chat.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  _msg: string,
  sessionDir: string,
  ctx: MessageContext,
): Promise<string> {
  ctx.sessionStore.setChatMode(sessionDir);
  return "已切回普通 claude 模式，只读助手";
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "chat",
    description: "切回普通 claude 模式",
    prefix: "/chat",
    minLevel: 1,
    isSetter: true,
    handler: handle,
  },
];

export default class ChatPlugin implements Plugin {
  name = "chat";
  version = "1.0.0";
  description = "/chat 指令 —— 切回普通 claude 模式";
  commands = COMMANDS;
}
