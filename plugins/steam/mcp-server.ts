/** Steam MCP Server —— 插件自带的 MCP 服务 */
import type { McpServer, McpToolDefinition } from "../../src/core/types.js";
import { getUserMapping } from "../../src/core/user_mapping.js";
import { fetchSteam, fetchSteamStoreSearch, isSteamApiError, steamIdsFromMapping } from "./shared.js";

function resolveSteamId(args: Record<string, unknown>): string {
  if (args.steam_id) return String(args.steam_id);
  if (args.qq) {
    const mapping = getUserMapping(Number(args.qq));
    const ids = steamIdsFromMapping(mapping);
    if (ids && ids.length > 0) return ids[0]; // 默认返回主号
  }
  return "";
}

function resolveAllSteamIds(args: Record<string, unknown>): string[] {
  if (args.steam_id) return [String(args.steam_id)];
  if (args.qq) {
    const mapping = getUserMapping(Number(args.qq));
    return steamIdsFromMapping(mapping);
  }
  return [];
}

const TOOLS: McpToolDefinition[] = [
  { name: "steam_get_player_summaries", description: "获取 Steam 玩家基本信息", inputSchema: { type: "object", properties: { steam_id: { type: "string" }, qq: { type: "integer" } }, required: [] } },
  { name: "steam_get_friend_list", description: "获取 Steam 好友列表", inputSchema: { type: "object", properties: { steam_id: { type: "string" }, qq: { type: "integer" } }, required: [] } },
  { name: "steam_get_owned_games", description: "获取拥有的游戏", inputSchema: { type: "object", properties: { steam_id: { type: "string" }, qq: { type: "integer" } }, required: [] } },
  { name: "steam_get_recently_played_games", description: "获取最近游玩", inputSchema: { type: "object", properties: { steam_id: { type: "string" }, qq: { type: "integer" }, count: { type: "integer" } }, required: [] } },
  { name: "steam_get_user_stats_for_game", description: "获取游戏统计/成就", inputSchema: { type: "object", properties: { steam_id: { type: "string" }, qq: { type: "integer" }, app_id: { type: "integer" } }, required: ["app_id"] } },
  { name: "steam_get_player_achievements", description: "获取游戏成就", inputSchema: { type: "object", properties: { steam_id: { type: "string" }, qq: { type: "integer" }, app_id: { type: "integer" } }, required: ["app_id"] } },
  { name: "steam_get_global_achievement_percentages", description: "获取成就全球完成率", inputSchema: { type: "object", properties: { app_id: { type: "integer" } }, required: ["app_id"] } },
  { name: "steam_search_games", description: "搜索 Steam 游戏", inputSchema: { type: "object", properties: { search: { type: "string" } }, required: ["search"] } },
  { name: "steam_resolve_vanity_url", description: "Vanity URL → SteamID64", inputSchema: { type: "object", properties: { vanity_url: { type: "string" } }, required: ["vanity_url"] } },
];

export function createSteamMcpServer(): McpServer {
  return {
    name: "qqbot-steam",
    version: "1.0.0",
    tools: TOOLS,
    async handleToolCall(name, args) {
      const sid = resolveSteamId(args);
      switch (name) {
        case "steam_get_player_summaries": {
          const ids = resolveAllSteamIds(args);
          if (ids.length === 0) return { error: "未找到 Steam ID" };
          return fetchSteam(`/ISteamUser/GetPlayerSummaries/v2/?steamids=${ids.join(",")}`);
        }
        case "steam_get_friend_list":
          if (!sid) return { error: "未找到 Steam ID" };
          return fetchSteam(`/ISteamUser/GetFriendList/v1/?steamid=${encodeURIComponent(sid)}`);
        case "steam_get_owned_games":
          if (!sid) return { error: "未找到 Steam ID" };
          return fetchSteam(`/IPlayerService/GetOwnedGames/v1/?steamid=${encodeURIComponent(sid)}&include_appinfo=true`);
        case "steam_get_recently_played_games":
          if (!sid) return { error: "未找到 Steam ID" };
          return fetchSteam(`/IPlayerService/GetRecentlyPlayedGames/v1/?steamid=${encodeURIComponent(sid)}&count=${args.count ?? 10}`);
        case "steam_get_user_stats_for_game":
          if (!sid) return { error: "未找到 Steam ID" };
          return fetchSteam(`/ISteamUserStats/GetUserStatsForGame/v2/?steamid=${encodeURIComponent(sid)}&appid=${args.app_id}`);
        case "steam_get_player_achievements":
          if (!sid) return { error: "未找到 Steam ID" };
          return fetchSteam(`/ISteamUserStats/GetPlayerAchievements/v1/?steamid=${encodeURIComponent(sid)}&appid=${args.app_id}`);
        case "steam_get_global_achievement_percentages": return fetchSteam(`/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${args.app_id}`);
        case "steam_search_games": {
          const data = await fetchSteamStoreSearch(String(args.search));
          if (isSteamApiError(data)) return data;
          const result = data as { items?: Array<{ id: number; name: string }> };
          return (result.items ?? []).slice(0, 15).map(i => ({ appid: i.id, name: i.name }));
        }
        case "steam_resolve_vanity_url": return fetchSteam(`/ISteamUser/ResolveVanityURL/v1/?vanityurl=${encodeURIComponent(String(args.vanity_url))}`);
        default: throw new Error(`Unknown tool: ${name}`);
      }
    },
  };
}
