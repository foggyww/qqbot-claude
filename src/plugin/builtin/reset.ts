/**
 * /reset 指令 —— 清空当前会话
 *
 * 对应 Python: src/qqbot/commands/builtin/reset.py
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { getConfig } from "../../core/config.js";
import { encodeProjectPath } from "../../core/encode-path.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rmDirIfExists(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function rmFileIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  _msg: string,
  sessionDir: string,
  _ctx: MessageContext,
): Promise<string> {
  const config = getConfig();
  const encoded = encodeProjectPath(sessionDir);

  // Clear claude user's session
  const claudeDir = path.join(config.paths.projectsDir, encoded);
  rmDirIfExists(claudeDir);

  // Clear root user's session
  const rootDir = path.join(config.paths.rootProjectsDir, encoded);
  rmDirIfExists(rootDir);

  // Clear session state files
  for (const f of [".model", ".effort", ".run_as_root"]) {
    rmFileIfExists(path.join(sessionDir, f));
  }

  return "会话已清空，下次对话重新开始";
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "reset",
    description: "清空当前会话",
    prefix: "/reset",
    minLevel: 2,
    handler: handle,
  },
];

export default class ResetPlugin implements Plugin {
  name = "reset";
  version = "1.0.0";
  description = "/reset 指令 —— 清空当前会话";
  commands = COMMANDS;
}
