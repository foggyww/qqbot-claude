/**
 * /model 指令 —— 切换模型
 *
 * 对应 Python: src/qqbot/commands/builtin/model.py
 */
import type { Command, MessageContext } from "../../core/types.js";
import { getConfig } from "../../core/config.js";
import type { Plugin } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  msg: string,
  sessionDir: string,
  ctx: MessageContext,
): Promise<string> {
  const config = getConfig();
  const models = config.models;
  const store = ctx.sessionStore;

  const name = msg.trim().toLowerCase();
  if (!name) {
    const current = store.loadModel(sessionDir);
    // Reverse lookup: find label for the current model value
    let label = "flash";
    for (const [k, v] of Object.entries(models)) {
      if (k !== "default" && v === current) {
        label = k;
        break;
      }
    }
    return `当前模型: ${label} (${current})\n可选: flash、pro`;
  }

  if (!(name in models) || name === "default") {
    return `未知模型: ${name}。可选: flash、pro`;
  }

  store.saveModel(sessionDir, name);
  return `已切换至 ${name} (${models[name]})`;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "model",
    description: "切换模型",
    prefix: "/model",
    minLevel: 2,
    isSetter: true,
    handler: handle,
  },
];

export default class ModelPlugin implements Plugin {
  name = "model";
  version = "1.0.0";
  description = "/model 指令 —— 切换模型";
  commands = COMMANDS;
}
