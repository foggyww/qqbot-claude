/** Steam 插件命令: /steam subscribe|unsubscribe|status|refresh */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command, MessageContext } from "../../src/core/types.js";
import { forceRefresh, restartOrStop } from "./watcher.js";

const SUBS_FILE = path.join(process.cwd(), "data", "steam_subscriptions.json");

function loadSubs(): Record<string, boolean> {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, "utf-8")); } catch { return {}; }
}
function saveSubs(data: Record<string, boolean>): void {
  fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(data), "utf-8");
}

async function handle(msg: string, sessionDir: string, ctx: MessageContext): Promise<string> {
  if (ctx.replyType !== "group") return "此命令仅在群聊中使用";

  const groupId = String(ctx.replyId);
  const sub = msg.trim().toLowerCase();
  const data = loadSubs();

  if (sub === "subscribe" || sub === "sub") {
    data[groupId] = true;
    saveSubs(data);
    restartOrStop();
    return "已开启本群 Steam 状态推送";
  }
  if (sub === "unsubscribe" || sub === "unsub") {
    data[groupId] = false;
    saveSubs(data);
    restartOrStop();
    return "已关闭本群 Steam 状态推送";
  }
  if (sub === "refresh") {
    const err = await forceRefresh(Number(groupId));
    return err ?? "已刷新当前 Steam 状态";
  }
  if (sub === "status" || sub === "") {
    const active = data[groupId] ?? false;
    const count = Object.values(data).filter(Boolean).length;
    return `本群: ${active ? "已订阅" : "未订阅"}\n当前活跃订阅: ${count} 个群`;
  }
  return "用法: /steam subscribe | unsubscribe | status | refresh";
}

export const steamCommands: Command[] = [
  {
    name: "steam",
    description: "Steam 状态监控订阅",
    prefix: "/steam",
    minLevel: 2,
    handler: handle,
  },
];
