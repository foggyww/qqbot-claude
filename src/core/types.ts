// ==== 消息与权限 ====

export interface MessageContext {
  sessionKey: string;
  replyType: "private" | "group";
  replyId: number;
  senderNick: string;
  senderQq: number;
  rawEvent: unknown;
  sessionStore: SessionStore;
  botQq: number;
  botNick: string;
}

export type RoleLevel = 0 | 1 | 2 | 3;

// ==== 命令系统 ====

export interface Command {
  name: string;
  description: string;
  prefix?: string;
  isDefault?: boolean;
  isSetter?: boolean;
  minLevel: RoleLevel;
  requireRoot?: boolean;
  handler: (msg: string, sessionDir: string, ctx: MessageContext) => Promise<string | void>;
}

// ==== AI 后端 ====

export interface AiBackend {
  ask(
    msg: string,
    sessionDir: string,
    sessionId?: string | null,
    systemPrompt?: string | null,
    model?: string,
    effort?: string,
    addDirs?: string,
    ccPluginDirs?: string[],
  ): Promise<string>;
}

// ==== 会话状态 ====

export interface SessionState {
  model: string;
  effort: string;
  isRoot: boolean;
}

export interface SessionStore {
  loadModel(sessionDir: string): string;
  saveModel(sessionDir: string, name: string): void;
  loadEffort(sessionDir: string): string;
  saveEffort(sessionDir: string, value: string): void;
  isRootMode(sessionDir: string): boolean;
  setRootMode(sessionDir: string): void;
  setChatMode(sessionDir: string): void;
  getSessionId(sessionDir: string, projectsDir?: string): string | null;
}

// ==== 定时任务 ====

export interface ScheduledTask {
  name: string;
  cron: string;
  msg: string;
  enabled: boolean;
}

// ==== MCP 工具 ====

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[]; default?: unknown; minimum?: number; maximum?: number }>;
    required: string[];
  };
}

// ==== 数据映射 ====

export interface UserMapping {
  desc?: string;
  my_qq: number;
  my_steam_id: string;
  users: Record<string, UserMappingEntry>;
}

export interface UserMappingEntry {
  nick?: string;
  /** Preferred schema: one QQ account may map to multiple Steam IDs. */
  steam_ids?: string[];
  /** Deprecated legacy primary Steam ID field. */
  steam_id?: string;
  /** Deprecated legacy alternate Steam ID field. */
  steam_alt?: string;
  note?: string;
}

export type SteamPlayerState = Record<string, {
  name: string;
  online: boolean;
  game: string;
}>;

export type SteamSubscriptionMap = Record<string, boolean>;

// ==== 群聊缓存 ====

export type GroupMessageCache = Map<number, string[]>;

export interface PendingMention {
  userId: number;
  deadline: number;
}

// ==== 插件 ====

export interface McpServer {
  name: string;
  version: string;
  tools: McpToolDefinition[];
  /** tools/call dispatcher: returns result text or throws */
  handleToolCall(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  commands?: Command[];
  /** 插件可声明自己提供的 MCP 服务 */
  mcpServers?: McpServer[];
  /** Claude Code 原生插件目录（相对于插件包根目录），包含 .claude-plugin/plugin.json、hooks/、skills/、commands/ 等 */
  ccPluginDir?: string;
  onLoad?(ctx: BotContext): Promise<void>;
  onUnload?(ctx: BotContext): Promise<void>;
  onMessage?(msgCtx: MessageContext): Promise<void>;
}

export interface BotContext {
  config: BotConfig;
  sessionDir: string;
  adapter: QQAdapter;
  sessionStore: SessionStore;
  sendMessage(type: "private" | "group", target: number, message: string): Promise<void>;
  logger: Logger;
  scheduler: SchedulerRef;
}

export interface SchedulerRef {
  addJob(
    fn: () => Promise<void>,
    trigger: { type: "interval"; minutes: number } | { type: "cron"; expression: string },
    id: string,
  ): void;
  removeJob(id: string): void;
  getJob(id: string): unknown;
}

// ==== 配置 ====

export interface BotConfig {
  qq: { account: number; platform?: string; nickname?: string };
  onebot: { wsUrl: string };
  paths: {
    sessionsDir: string;
    projectsDir: string;
    workspaceDir: string;
    projectDir: string;
    rootProjectsDir: string;
  };
  env: Record<string, string>;
  run: { user?: string; uid?: number; gid?: number; useSudo: boolean };
  models: Record<string, string> & { default: string };
  efforts: { default: string };
  settings: { timeout: number; noPermissionReply: string };
  roles: Record<number, RoleLevel>;
  groupWhitelist: number[];
  tools: string[];
  prompt: { masterQq: number };
  steamWatcher: { intervalMinutes: number };
}

// ==== 基础接口 ====

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface QQAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msgCtx: MessageContext) => Promise<void>): void;
  sendPrivateMsg(userId: number, message: string): Promise<void>;
  sendGroupMsg(groupId: number, message: string): Promise<void>;
  getGroupList(): Promise<Array<{ id: number; name: string }>>;
  getGroupMembers(groupId: number): Promise<Array<{ qq: number; nick: string; card: string; role: string }>>;
  getGroupMsgHistory(groupId: number, count?: number): Promise<Array<{ qq: number; nick: string; text: string }>>;
  getPrivateMsgHistory(userId: number, count?: number): Promise<Array<{ qq: number; nick: string; text: string }>>;
  getStrangerInfo(userId: number): Promise<unknown>;
  deleteMsg(messageId: number): Promise<void>;
}
