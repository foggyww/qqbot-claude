import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getConfig } from "./config.js";
import type { RawMessageEvent } from "./context.js";
import { dispatchMessage, setSessionStore } from "./router.js";
import type { BotConfig, BotContext, Logger, MessageContext, QQAdapter, SessionStore, SessionState, SchedulerRef } from "./types.js";
import { PluginSystem } from "../plugin/index.js";
import { setCcPluginDirs, setMcpServerNames, startClaudeProcesses, stopClaudeProcesses } from "../ai/claude-code.js";
import { clearAccountingInvocations, withAccountingRequestContext } from "./accounting-request-context.js";
import { MessageDeduplicator } from "./message-deduplicator.js";
import { createQqMcpServer } from "../mcp/qq-server.js";
import { McpHost } from "../mcp/host.js";
import { getScheduler, startScheduler } from "../scheduler/index.js";
import { getProjectSessionId } from "./encode-path.js";

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
      // Auto-detect root mode: if .run_as_root exists, use root's project dir
      const baseDir = projectsDir ?? (fs.existsSync(path.join(dir, ".run_as_root")) ? config.paths.rootProjectsDir : config.paths.projectsDir);
      return getProjectSessionId(dir, baseDir);
    },
  };
}

function extractNickname(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const obj = info as Record<string, unknown>;
  const candidates = [obj.nickname, obj.nick, obj.card, obj.user_name];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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
  private botNick = "QQBot";

  private started = false;
  private mcpHost: McpHost | null = null;
  private readonly receivedMessages = new MessageDeduplicator();
  private stopping = false;

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
    this.botNick = config.qq.nickname?.trim() || "QQBot";
    setSessionStore(this.sessionStore, this.botNick);

    this.logger.info(`配置加载完成，QQ=${config.qq.account}，昵称=${this.botNick}`);

    // 2. 加载插件（插件注册命令）
    await this.pluginSystem.loadPlugins();

    // 2.1 注册项目内置 QQ MCP server（复用当前 adapter，不依赖旧 HTTP API）
    await this.pluginSystem.register({
      name: "qq-mcp",
      version: "3.0.0",
      description: "内置 QQ MCP server",
      mcpServers: [createQqMcpServer(this.adapter)],
    });

    // 3. 将插件提供的 Claude Code 能力注入 AI backend
    setCcPluginDirs(this.pluginSystem.getCcPluginDirs());
    setMcpServerNames(this.pluginSystem.getAllMcpServers().map((item) => item.server.name));

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

    this.stopping = false;
    startClaudeProcesses();
    // 注册消息处理回调
    this.adapter.onMessage(async (msgCtx) => {
      await this.handleIncomingMessage(msgCtx);
    });

    try {
      // Expose tools before QQ can deliver commands requiring them.
      this.mcpHost = new McpHost(
        this.pluginSystem.getAllMcpServers().map((item) => item.server),
        this.logger,
      );
      await this.mcpHost.start();
      await this.adapter.start();
      await this.resolveBotNickAfterConnect();
      this.restoreScheduledTasks();
      this.started = true;
      this.logger.info("Bot 已启动");
    } catch (error) {
      await this.stop();
      throw error;
    }
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
      try {
        scheduler.reloadFrom(sessionDir);
        restored += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`恢复定时任务失败 (${entry.name}): ${message}`);
      }
    }

    this.logger.info(`Scheduler 已启动，已扫描 ${restored} 个定时任务会话`);
  }

  private async resolveBotNickAfterConnect(): Promise<void> {
    if (this.config.qq.nickname?.trim()) return;
    try {
      const info = await this.adapter.getStrangerInfo(this.config.qq.account);
      const nickname = extractNickname(info);
      if (nickname) {
        this.botNick = nickname;
        setSessionStore(this.sessionStore, this.botNick);
        this.logger.info(`已从 OneBot 获取 Bot 昵称：${this.botNick}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`获取 Bot 昵称失败，继续使用 ${this.botNick}: ${msg}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.scheduler.stop?.();
    clearAccountingInvocations();
    stopClaudeProcesses();
    await this.pluginSystem.unregisterAll();
    try {
      await this.mcpHost?.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`停止 MCP Host 失败: ${message}`);
    } finally {
      this.mcpHost = null;
    }
    try {
      await this.adapter.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`停止 QQ Adapter 失败: ${message}`);
    }
    this.started = false;
    this.logger.info("Bot 已停止");
  }

  /**
   * 运行直到进程退出信号。
   */
  async runForever(): Promise<void> {
    const shutdown = async (signal: string) => {
      this.logger.info(`收到 ${signal}，正在停止...`);
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error(`停止失败: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
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
    if (this.stopping) return;
    let eventKey: string | undefined;
    try {
      msgCtx.botNick = this.botNick;
      const raw = msgCtx.rawEvent;
      if (!raw || typeof raw !== "object") return;
      const event = this.ensureRawEvent(raw, msgCtx);
      if (!Number.isSafeInteger(event.message_id) || !Number.isSafeInteger(msgCtx.senderQq) || msgCtx.senderQq <= 0) {
        this.logger.warn("丢弃缺少有效消息身份的事件");
        return;
      }
      const key = `${event.self_id}:${event.message_type}:${event.group_id ?? 0}:${event.user_id}:${event.message_id}`;
      if (!this.receivedMessages.begin(key)) return;
      eventKey = key;
      await this.pluginSystem.onMessage(msgCtx);
      if (this.stopping) return;
      const reply = await withAccountingRequestContext(
        { senderQq: msgCtx.senderQq, messageId: String(event.message_id) },
        () => dispatchMessage(event),
      );
      if (reply) {
        await this.sendMessage(msgCtx.replyType, msgCtx.replyId, reply);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`消息处理异常: ${msg}`);
    } finally {
      if (eventKey) this.receivedMessages.finish(eventKey);
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
        typeof r.message_id === "number" ? r.message_id : typeof r.message_id === "string" && /^-?\d+$/.test(r.message_id) ? Number(r.message_id) : NaN,
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
