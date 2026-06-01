/**
 * /help 指令 —— 列出所有命令
 *
 * 对应 Python: src/qqbot/commands/builtin/help_cmd.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { getDefaultCommand, getRegisteredCommands } from "../../core/router.js";
import { LEVEL_LABELS } from "../../core/permission.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  _msg: string,
  _sessionDir: string,
  _ctx: MessageContext,
): Promise<string> {
  const lines: string[] = ["可用命令：", ""];

  const defaultCmd = getDefaultCommand();
  if (defaultCmd) {
    lines.push(
      `  (默认对话)  Lv${defaultCmd.minLevel}+  ${defaultCmd.name}`,
    );
  }

  const commands = getRegisteredCommands();
  const sorted = [...commands.values()].sort((a, b) =>
    (a.prefix ?? "").localeCompare(b.prefix ?? ""),
  );

  for (const c of sorted) {
    const req: string[] = [];
    if (c.minLevel) {
      req.push(`Lv${c.minLevel}+`);
    }
    if (c.requireRoot) {
      req.push("需 /root 模式");
    }
    if (c.isSetter) {
      req.push("切换状态");
    }
    const cond = req.length > 0 ? " " + req.join(" ") : "";
    const prefix = c.prefix || "(默认)";
    lines.push(`  ${prefix.padEnd(16)} ${LEVEL_LABELS[c.minLevel]}${cond}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "help",
    description: "列出所有命令",
    prefix: "/help",
    minLevel: 1,
    handler: handle,
  },
];

export default class HelpPlugin implements Plugin {
  name = "help";
  version = "1.0.0";
  description = "/help 指令 —— 列出所有命令";
  commands = COMMANDS;
}
