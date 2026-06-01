/**
 * /root 指令 —— 切换 root 模式
 *
 * 对应 Python: src/qqbot/commands/builtin/root.py
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
  ctx.sessionStore.setRootMode(sessionDir);
  return "已切换至 root 模式，当前会话生效。所有消息将以 root 身份运行，具有完整读写权限";
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "root",
    description: "切换 root 模式",
    prefix: "/root",
    minLevel: 3,
    isSetter: true,
    handler: handle,
  },
];

export default class RootPlugin implements Plugin {
  name = "root";
  version = "1.0.0";
  description = "/root 指令 —— 切换 root 模式";
  commands = COMMANDS;
}
