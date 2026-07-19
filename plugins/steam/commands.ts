/** Steam 插件命令: /steam subscribe|unsubscribe|status|refresh */
import type { Command, MessageContext } from "../../src/core/types.js";
import { loadSteamSubscriptions, saveSteamSubscriptions } from "./shared.js";
import { initializeWeeklyGroup } from "./weekly.js";
import { forceRefresh, restartOrStop } from "./watcher.js";

async function handle(msg: string, sessionDir: string, ctx: MessageContext): Promise<string> {
  if (ctx.replyType !== "group") return "此命令仅在群聊中使用";

  const groupId = String(ctx.replyId);
  const sub = msg.trim().toLowerCase();
  const data = loadSteamSubscriptions();
  const subscription = data[groupId] ?? { status: false, weekly: false };

  if (sub === "subscribe" || sub === "sub") {
    subscription.status = true;
    data[groupId] = subscription;
    saveSteamSubscriptions(data);
    restartOrStop();
    return "已开启本群 Steam 状态推送";
  }
  if (sub === "unsubscribe" || sub === "unsub") {
    subscription.status = false;
    data[groupId] = subscription;
    saveSteamSubscriptions(data);
    restartOrStop();
    return "已关闭本群 Steam 状态推送";
  }
  if (sub === "refresh") {
    const err = await forceRefresh(Number(groupId));
    return err ?? "已刷新当前 Steam 状态";
  }
  if (sub === "status" || sub === "") {
    const count = Object.values(data).filter((entry) => entry.status).length;
    return `Steam 状态推送: ${subscription.status ? "已订阅" : "未订阅"}\nSteam 游戏周榜: ${subscription.weekly ? "已订阅" : "未订阅"}\n当前状态推送订阅: ${count} 个群`;
  }
  if (sub === "weekly subscribe" || sub === "weekly sub") {
    const wasSubscribed = subscription.weekly;
    subscription.weekly = true;
    data[groupId] = subscription;
    saveSteamSubscriptions(data);
    const result = await initializeWeeklyGroup(Number(groupId), !wasSubscribed);
    return result ?? "已开启本群 Steam 游戏周榜，并建立当前游玩时长基线";
  }
  if (sub === "weekly unsubscribe" || sub === "weekly unsub") {
    subscription.weekly = false;
    data[groupId] = subscription;
    saveSteamSubscriptions(data);
    return "已关闭本群 Steam 游戏周榜";
  }
  if (sub === "weekly status") {
    return `本群 Steam 游戏周榜: ${subscription.weekly ? "已订阅" : "未订阅"}`;
  }
  return "用法: /steam subscribe | unsubscribe | status | refresh | weekly subscribe | weekly unsubscribe | weekly status";
}

export const steamCommands: Command[] = [
  {
    name: "steam",
    description: "Steam 状态监控与游戏周榜订阅",
    prefix: "/steam",
    minLevel: 2,
    handler: handle,
  },
];
