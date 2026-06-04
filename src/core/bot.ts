import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getConfig } from "./config.js";
import type { RawMessageEvent } from "./context.js";
import { dispatchMessage, setSessionStore } from "./router.js";
import type { BotConfig, BotContext, Logger, MessageContext, QQAdapter, SessionStore, SessionState, SchedulerRef } from "./types.js";
import { PluginSystem } from "../plugin/index.js";
import { setCcPluginDirs } from "../ai/claude-code.js";
import { createQqMcpServer } from "../mcp/qq-server.js";
import { McpHost } from "../mcp/host.js";
import { getScheduler, startScheduler } from "../scheduler/index.js";

// ---------------------------------------------------------------------------
// Default logger
// ---------------------------------------------------------------------------

function createLogger(name: string): Logger {
  const prefix = `[${name}]`;
  const ts = () => new Date().toISOString();
  return {
    info(msg: string) {
      console.log(`${ts()} ${prefix} INFO  ${msg}`);
    },
    warn(msg: string) {
      console.warn(`${ts()} ${prefix} WARN  ${msg}`);
    },
    error(msg: string) {
      console.error(`${ts()} ${prefix} ERROR ${msg}`);
    },
    debug(msg: string) {
      if (process.env.DEBUG) {
        console.debug(`${ts()} ${prefix} DEBUG ${msg}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Session state management
// ---------------------------------------------------------------------------

function getSessionDir(sessionKey: string): string {
  const config = getConfig();
  return path.join(config.paths.sessionsDir, sessionKey);
}

function readStateFile(sessionDir: string, name: string): string | null {
  const p = path.join(sessionDir, name);
  if (fs.existsSync(p)) {
    return fs.readFileSync(p, "utf-8").trim();
  }
  return null;
}

function isRootMode(sessionDir: string): boolean {
  return fs.existsSync(path.join(sessionDir, ".run_as_root"));
}

function createSessionStore(): SessionStore {
  const encode = (p: string) => p.split("/").map(s => s.replace(/[^a-zA-Z0-9]/g, "-")).join("-");

  return {
    loadModel(dir: string) {
      const config = getConfig();
      const v = readStateFile(dir, ".model") ?? config.models.default;
      return config.models[v] ?? config.models.flash ?? v;
    },
    saveModel(dir: string, name: string) { fs.writeFileSync(path.join(dir, ".model"), name, "utf-8"); },
    loadEffort(dir: string) { return readStateFile(dir, ".effort") ?? getConfig().efforts.default; },
    saveEffort(dir: string, value: string) { fs.writeFileSync(path.join(dir, ".effort"), value, "utf-8"); },
    isRootMode(dir: string) { return fs.existsSync(path.join(dir, ".run_as_root")); },
    setRootMode(dir: string) { fs.writeFileSync(path.join(dir, ".run_as_root"), "1", "utf-8"); },
    setChatMode(dir: string) {
      const p = path.join(dir, ".run_as_root");
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
    getSessionId(dir: string, projectsDir?: string): string | null {
      const config = getConfig();
      const encoded = encode(dir);
      // Auto-detect root mode: if .run_as_root exists, use root's project dir
      const baseDir = projectsDir ?? (fs.existsSync(path.join(dir, ".run_as_root")) ? config.paths.rootProjectsDir : config.paths.projectsDir);
      const projectDir = path.join(baseDir, encoded);
      if (!fs.existsSync(projectDir)) return null;
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
      if (files.length === 0) return null;
      const latest = files.reduce((a, b) =>
        (fs.statSync(path.join(projectDir, a)).mtimeMs > fs.statSync(path.join(projectDir, b)).mtimeMs) ? a : b
      );
      return latest.replace(".jsonl", "");
    },
  };
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class Bot {
  config!: BotConfig;
  readonly adapter: QQAdapter;
  readonly logger: Logger;
  readonly pluginSystem: PluginSystem;
  readonly botCtx: BotContext;
  readonly sessionStore: SessionStore;
  readonly scheduler: SchedulerRef;

  private started = false;
  private mcpHost: McpHost | null = null;

  constructor(adapter: QQAdapter, sessionStore?: SessionStore, scheduler?: SchedulerRef) {
    this.adapter = adapter;
    this.logger = createLogger("bot");
    this.sessionStore = sessionStore ?? createSessionStore();
    this.scheduler = scheduler ?? getScheduler();

    this.botCtx = {
      config: {} as BotConfig,
      sessionDir: "",
      adapter: this.adapter,
      sendMessage: this.sendMessage.bind(this),
      logger: this.logger,
      sessionStore: this.sessionStore,
      scheduler: this.scheduler,
    };

    this.pluginSystem = new PluginSystem(this.botCtx);
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * 加载配置、扫描插件。
   * 必须在 start() 之前调用。
   */
  async init(configPath?: string): Promise<void> {
    // 1. 加载配置
    const config = await loadConfig(configPath);
    this.config = config;
    this.botCtx.config = config;

    // Make configured env available to in-process plugins as well as Claude subprocesses.
    for (const [key, value] of Object.entries(config.env)) {
      if (value) {
        process.env[key] = value;
      }
    }

    // 确保 sessionsDir 存在
    fs.mkdirSync(config.paths.sessionsDir, { recursive: true });
    this.botCtx.sessionDir = config.paths.sessionsDir;

    // 注入 session store 到路由器
    setSessionStore(this.sessionStore);

    this.logger.info(`配置加载完成，QQ=${config.qq.account}`);

    // 2. 加载插件（插件注册命令）
    await this.pluginSystem.loadPlugins();

    // 2.1 注册项目内置 QQ MCP server（复用当前 adapter，不依赖旧 HTTP API）
    await this.pluginSystem.register({
      name: "qq-mcp",
      version: "3.0.0",
      description: "内置 QQ MCP server",
      mcpServers: [createQqMcpServer(this.adapter)],
    });

    // 3. 将 CC 原生插件目录注入 Claude Code
    setCcPluginDirs(this.pluginSystem.getCcPluginDirs());

    this.logger.info(`插件加载完成，${this.pluginSystem.list().length} 个插件已就绪`);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      this.logger.warn("Bot 已启动，跳过重复启动");
      return;
    }

    // 注册消息处理回调
    this.adapter.onMessage(async (msgCtx) => {
      await this.handleIncomingMessage(msgCtx);
    });

    // 启动适配器
    await this.adapter.start();

    // 启动项目内 MCP Host，生命周期跟随 Bot
    this.mcpHost = new McpHost(
      this.pluginSystem.getAllMcpServers().map((item) => item.server),
      this.logger,
    );
    await this.mcpHost.start();

    // 恢复持久化定时任务。定时器保存在内存中，进程重启后必须从各 session 的
    // .schedules.json 重新加载，否则磁盘上有任务但不会触发。
    this.restoreScheduledTasks();

    this.started = true;
    this.logger.info("Bot 已启动");
  }

  private restoreScheduledTasks(): void {
    const scheduler = startScheduler();
    const sessionsDir = this.config.paths.sessionsDir;

    if (!fs.existsSync(sessionsDir)) {
      this.logger.info("Scheduler 已启动，未发现 sessions 目录");
      return;
    }

    let restored = 0;
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(sessionsDir, entry.name);
      if (!fs.existsSync(path.join(sessionDir, ".schedules.json"))) continue;
      scheduler.removeAllFor(sessionDir);
      scheduler.reloadFrom(sessionDir);
      restored += 1;
    }

    this.logger.info(`Scheduler 已启动，已扫描 ${restored} 个定时任务会话`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.mcpHost?.stop();
    this.mcpHost = null;
    await this.adapter.stop();
    this.started = false;
    this.logger.info("Bot 已停止");
  }

  /**
   * 运行直到进程退出信号。
   */
  async runForever(): Promise<void> {
    const shutdown = async (signal: string) => {
      this.logger.info(`收到 ${signal}，正在停止...`);
      await this.stop();
      process.exit(0);
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    await this.start();

    // 保持事件循环存活
    await new Promise(() => {
      // 永不 resolve — 由信号处理
    });
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  /**
   * 插件注册的回调格式 → 路由器需要的 RawMessageEvent 格式。
   */
  private async handleIncomingMessage(
    msgCtx: MessageContext,
  ): Promise<void> {
    // 通知所有插件 onMessage（被动监听）
    await this.pluginSystem.onMessage(msgCtx);

    // 构建 RawMessageEvent 供路由器使用
    const raw = msgCtx.rawEvent;
    if (!raw || typeof raw !== "object") return;

    // 如果 rawEvent 已经是路由器期望的结构，直接使用
    // 否则从 MessageContext 反向构造
    const event = this.ensureRawEvent(raw, msgCtx);

    try {
      const reply = await dispatchMessage(event);
      if (reply) {
        await this.sendMessage(msgCtx.replyType, msgCtx.replyId, reply);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`消息处理异常: ${msg}`);
    }
  }

  /**
   * 确保 rawEvent 符合 RawMessageEvent 形状。
   * 适配器如果已经传入标准格式，直接使用；否则从 MessageContext 补充。
   */
  private ensureRawEvent(
    raw: object,
    ctx: MessageContext,
  ): RawMessageEvent {
    const r = raw as Record<string, unknown>;

    return {
      message_type:
        (typeof r.message_type === "string"
          ? r.message_type
          : ctx.replyType) as string,
      user_id:
        typeof r.user_id === "number" ? r.user_id : ctx.senderQq,
      self_id:
        (typeof r.self_id === "number"
          ? r.self_id
          : this.config.qq.account) as number,
      sender: {
        user_id:
          (typeof (r.sender as Record<string, unknown>)?.user_id === "number"
            ? ((r.sender as Record<string, unknown>).user_id as number)
            : ctx.senderQq),
        nickname:
          (typeof (r.sender as Record<string, unknown>)?.nickname === "string"
            ? ((r.sender as Record<string, unknown>).nickname as string)
            : ctx.senderNick),
      },
      raw_message:
        typeof r.raw_message === "string"
          ? r.raw_message
          : (r.message as string) ?? "",
      message_id:
        typeof r.message_id === "number" ? r.message_id : 0,
      message: r.message ?? "",
      group_id:
        typeof r.group_id === "number"
          ? r.group_id
          : ctx.replyType === "group"
            ? ctx.replyId
            : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Utilities exposed via BotContext
  // -----------------------------------------------------------------------

  async sendMessage(
    type: "private" | "group",
    target: number,
    message: string,
  ): Promise<void> {
    if (type === "private") {
      await this.adapter.sendPrivateMsg(target, message);
    } else {
      await this.adapter.sendGroupMsg(target, message);
    }
  }

  async getSessionState(sessionKey: string): Promise<SessionState> {
    const dir = getSessionDir(sessionKey);
    const config = getConfig();
    return {
      model: readStateFile(dir, ".model") ?? config.models.default,
      effort: readStateFile(dir, ".effort") ?? config.efforts.default,
      isRoot: isRootMode(dir),
    };
  }
}

// Re-export for convenience
export { dispatchMessage } from "./router.js";
