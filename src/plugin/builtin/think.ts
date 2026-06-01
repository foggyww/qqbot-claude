/**
 * /think 指令 —— 调整思考强度
 *
 * 对应 Python: src/qqbot/commands/builtin/think.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const LABELS: Record<string, string> = {
  low: "低 - 快速浅层",
  medium: "中 - 均衡",
  high: "高 (默认) - 更深入",
  xhigh: "极高 - 更强推理",
  max: "最大 - 最强但最慢",
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  msg: string,
  sessionDir: string,
  ctx: MessageContext,
): Promise<string> {
  const store = ctx.sessionStore;
  const name = msg.trim().toLowerCase();

  if (!name) {
    const current = store.loadEffort(sessionDir);
    return `当前思考强度: ${current} (${LABELS[current] ?? current})`;
  }

  if (!EFFORTS.has(name)) {
    const opts = Object.entries(LABELS)
      .map(([k, v]) => `  ${k} - ${v}`)
      .join("\n");
    return `可选强度:\n${opts}`;
  }

  store.saveEffort(sessionDir, name);
  return `已切换至 ${name} (${LABELS[name]})`;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "think",
    description: "调整思考强度",
    prefix: "/think",
    minLevel: 2,
    isSetter: true,
    handler: handle,
  },
];

export default class ThinkPlugin implements Plugin {
  name = "think";
  version = "1.0.0";
  description = "/think 指令 —— 调整思考强度";
  commands = COMMANDS;
}
