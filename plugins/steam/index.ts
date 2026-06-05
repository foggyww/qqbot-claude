/** Steam 插件 —— 自包含：命令 + MCP + 监控 */
import type { Plugin, Command, McpServer, BotContext } from "../../src/core/types.js";
import { getMyInfo } from "../../src/core/user_mapping.js";
import { steamCommands } from "./commands.js";
import { createSteamMcpServer } from "./mcp-server.js";
import { initWatcher, stopWatcher } from "./watcher.js";

export class SteamPlugin implements Plugin {
  name = "steam";
  version = "1.0.0";
  description = "Steam 状态监控、游戏查询、好友管理";
  /** CC 原生插件：hooks、skills 等 */
  ccPluginDir = "claude-plugin";

  commands: Command[] = steamCommands;
  mcpServers: McpServer[] = [createSteamMcpServer()];

  async onLoad(ctx: BotContext): Promise<void> {
    // 从 user_mapping 获取 API key
    const myInfo = getMyInfo() as Record<string, unknown>;
    const apiKey = (process.env.STEAM_WEB_API_KEY ?? process.env.STEAM_API_KEY ?? myInfo.steam_api_key ?? "") as string;
    initWatcher(ctx, apiKey);
  }

  async onUnload(_ctx: BotContext): Promise<void> {
    void _ctx;
    stopWatcher();
  }
}

export default SteamPlugin;
