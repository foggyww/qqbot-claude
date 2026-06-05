export { Bot } from "./bot.js";
export { loadConfig, getConfig, resetConfigCache, findDataDir } from "./config.js";
export { buildCtx, sessionKey, stripContent, isMentioned } from "./context.js";
export type { RawMessageEvent } from "./context.js";
export { getLevel, isGroupWhitelisted, LEVEL_LABELS } from "./permission.js";
export {
  dispatchMessage,
  getDefaultCommand,
  getRegisteredCommands,
  registerCommand,
  resolveCommand,
  setSessionStore,
  unregisterCommand,
} from "./router.js";
export { getMyInfo, getUserMapping, setMappingFile, setUserField } from "./user_mapping.js";
export type {
  AiBackend,
  BotConfig,
  BotContext,
  Command,
  GroupMessageCache,
  Logger,
  McpServer,
  McpToolDefinition,
  MessageContext,
  PendingMention,
  Plugin,
  QQAdapter,
  RoleLevel,
  ScheduledTask,
  SchedulerRef,
  SessionState,
  SessionStore,
  SteamPlayerState,
  SteamSubscriptionMap,
  UserMapping,
} from "./types.js";

export { OneBotAdapter, DEFAULT_WS_URL } from "../adapter/onebot.js";
export {
  askClaude,
  askClaudeRoot,
  ClaudeCodeBackend,
  ClaudeCodeRootBackend,
  getClaudeCodeBackend,
  getClaudeCodeRootBackend,
  getSessionId,
  setCcPluginDirs,
  TimeoutError,
} from "../ai/claude-code.js";
export { PluginSystem } from "../plugin/index.js";
export { clearPromptCache, loadPrompt, setPromptsDir } from "../prompt.js";
export { getScheduler, reloadFrom, removeAllFor, SchedulerImpl, startScheduler } from "../scheduler/index.js";
export { createQqMcpServer, QQ_MCP_TOOLS } from "../mcp/qq-server.js";
export { McpHost } from "../mcp/host.js";

import { OneBotAdapter } from "../adapter/onebot.js";
import { Bot } from "./bot.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;

  const config = await loadConfig(configPath);
  const adapter = new OneBotAdapter(config.onebot.wsUrl);
  const bot = new Bot(adapter);
  await bot.init(configPath);
  await bot.runForever();
}

const entry = process.argv[1] ?? "";
const isDirectRun = /(?:^|[/\\])core[/\\]index\.(?:ts|js)$/.test(entry);

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
