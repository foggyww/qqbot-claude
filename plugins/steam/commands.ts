/** Steam 插件命令: /steam subscribe|unsubscribe|status|refresh */
import type { Command, MessageContext } from "../../src/core/types.js";
import {
  areSteamNotificationsEnabled,
  loadSteamSubscriptions,
  saveSteamSubscriptions,
  setSteamNotificationsEnabled,
} from "./shared.js";
import { publishRecentTwoWeekRanking } from "./weekly.js";
import { forceRefresh, restartOrStop } from "./watcher.js";

export async function handleSteamCommand(
  msg: string,
  sessionDir: string,
  ctx: MessageContext,
  publishRecent = publishRecentTwoWeekRanking,
): Promise<string | void> {
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
    subscription.weekly = true;
    data[groupId] = subscription;
    saveSteamSubscriptions(data);
    return "已开启本群每周日 Steam 最近两周游戏榜";
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
  if (sub === "recent" || sub === "2weeks" || sub === "two-weeks") {
    const result = await publishRecent(Number(groupId));
    if (result.ok) return;
    return `生成 Steam 最近两周榜失败：${result.error ?? "未知错误"}`;
  }
  return "用法: /steam subscribe | unsubscribe | status | refresh | weekly subscribe | weekly unsubscribe | weekly status | recent\n管理员: /steam notify on | off | status";
}

export async function handleSteamNotifyCommand(
  msg: string,
  setEnabled = setSteamNotificationsEnabled,
  getEnabled = areSteamNotificationsEnabled,
): Promise<string> {
  const sub = msg.trim().toLowerCase();
  if (sub === "on" || sub === "enable") {
    setEnabled(true);
    return "已开启全部 Steam 上下线及游戏状态通知";
  }
  if (sub === "off" || sub === "disable") {
    setEnabled(false);
    return "已关闭全部 Steam 上下线及游戏状态通知";
  }
  if (sub === "status" || sub === "") {
    return `Steam 上下线及游戏状态通知: ${getEnabled() ? "已开启" : "已关闭"}`;
  }
  return "用法: /steam notify on | off | status";
}

export const steamCommands: Command[] = [
  {
    name: "steam-notify",
    description: "全局开启或关闭 Steam 上下线及游戏状态通知",
    prefix: "/steam notify",
    minLevel: 3,
    handler: (msg) => handleSteamNotifyCommand(msg),
  },
  {
    name: "steam",
    description: "Steam 状态监控与游戏周榜订阅",
    prefix: "/steam",
    minLevel: 2,
    handler: (msg, sessionDir, ctx) => handleSteamCommand(msg, sessionDir, ctx),
  },
];
