/** Steam 插件 —— 自包含：命令 + MCP + 监控 */
import type { Plugin, Command, McpServer, BotContext } from "../../src/core/types.js";
import { secureUserMappingFile } from "../../src/core/user_mapping.js";
import { steamCommands } from "./commands.js";
import { createSteamMcpServer } from "./mcp-server.js";
import { apiKey, secureExistingSteamData } from "./shared.js";
import { initWatcher, stopWatcher } from "./watcher.js";
import { initWeekly, stopWeekly } from "./weekly.js";

export class SteamPlugin implements Plugin {
  name = "steam";
  version = "1.0.0";
  description = "Steam 状态监控、游戏查询、好友管理";
  /** CC 原生插件：hooks、skills 等 */
  ccPluginDir = "claude-plugin";

  commands: Command[] = steamCommands;
  mcpServers: McpServer[] = [createSteamMcpServer()];

  async onLoad(ctx: BotContext): Promise<void> {
    secureExistingSteamData();
    secureUserMappingFile();
    const key = apiKey();
    initWatcher(ctx, key);
    initWeekly(ctx, key);
  }

  async onUnload(ctx: BotContext): Promise<void> {
    stopWatcher();
    await stopWeekly(ctx);
  }
}

export default SteamPlugin;
