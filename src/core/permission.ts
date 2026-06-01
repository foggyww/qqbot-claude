import { getConfig } from "./config.js";
import type { RoleLevel } from "./types.js";

/**
 * 获取用户的权限等级。
 * @returns 0=访客, 1=用户, 2=可信用户, 3=管理员
 */
export function getLevel(userId: number): RoleLevel {
  const config = getConfig();
  return config.roles[userId] ?? 0;
}

/**
 * 检查群是否在白名单内。
 */
export function isGroupWhitelisted(groupId: number): boolean {
  const config = getConfig();
  return config.groupWhitelist.includes(groupId);
}

/**
 * 权限等级标签（中文）。
 */
export const LEVEL_LABELS: Record<RoleLevel, string> = {
  0: "访客",
  1: "用户",
  2: "可信用户",
  3: "管理员",
};
