import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config.js";
import {
  buildCtx,
  sessionKey,
  isMentioned,
  stripContent,
} from "./context.js";
import type { RawMessageEvent } from "./context.js";
import { getLevel, isGroupWhitelisted, LEVEL_LABELS } from "./permission.js";
import type { Command, SessionStore } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level session store (set by Bot.init)
// ---------------------------------------------------------------------------

let _sessionStore: SessionStore | null = null;
let _botNick = "foggymm";

/** Set the session store for use by command handlers */
export function setSessionStore(store: SessionStore, botNick?: string): void {
  _sessionStore = store;
  if (botNick) _botNick = botNick;
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

const commands = new Map<string, Command>();
let defaultCommand: Command | null = null;

export function registerCommand(cmd: Command): void {
  if (cmd.prefix !== undefined && cmd.prefix !== "") {
    if (commands.has(cmd.prefix)) {
      console.warn(`命令前缀 "${cmd.prefix}" 已存在，将被 "${cmd.name}" 覆盖`);
    }
    commands.set(cmd.prefix, cmd);
  }
  if (cmd.isDefault) {
    if (defaultCommand) {
      console.warn(`默认命令 "${defaultCommand.name}" 将被 "${cmd.name}" 覆盖`);
    }
    defaultCommand = cmd;
  }
}

export function unregisterCommand(prefix: string): void {
  const cmd = commands.get(prefix);
  commands.delete(prefix);
  if (cmd === defaultCommand) {
    defaultCommand = null;
  }
}

export function unregisterDefaultCommand(cmd?: Command): void {
  if (!cmd || defaultCommand === cmd) {
    defaultCommand = null;
  }
}

export function getDefaultCommand(): Command | null {
  return defaultCommand;
}

export function getRegisteredCommands(): Map<string, Command> {
  return commands;
}

// ---------------------------------------------------------------------------
// Resolve command from message text
// ---------------------------------------------------------------------------

/**
 * 从消息文本中解析指令。
 * 返回 [匹配到的命令, 去除前缀后的剩余文本]。
 * 如果匹配不到任何前缀指令，返回默认命令 + 原始消息。
 */
export function resolveCommand(
  msg: string,
): { command: Command | null; remaining: string } {
  // 按前缀长度降序排列，优先匹配最长前缀
  const sorted = [...commands.entries()].sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [prefix, cmd] of sorted) {
    if (msg === prefix) {
      return { command: cmd, remaining: "" };
    }
    if (msg.startsWith(prefix + " ")) {
      return { command: cmd, remaining: msg.slice(prefix.length).trim() };
    }
  }
  return { command: defaultCommand, remaining: msg };
}

// ---------------------------------------------------------------------------
// Session state helpers
// ---------------------------------------------------------------------------

function getSessionDir(sessionKeyStr: string): string {
  const config = getConfig();
  return path.join(config.paths.sessionsDir, sessionKeyStr);
}

function isRootMode(sessionKeyStr: string): boolean {
  const dir = getSessionDir(sessionKeyStr);
  return fs.existsSync(path.join(dir, ".run_as_root"));
}

// ---------------------------------------------------------------------------
// Group message cache & pending mentions
// ---------------------------------------------------------------------------

interface PendingMention {
  userId: number;
  deadline: number; // epoch ms
}

const groupCache = new Map<number, string[]>();
const MAX_CACHE_SIZE = 20;

const pendingMentions = new Map<number, PendingMention>();

function addToGroupCache(
  groupId: number,
  nick: string,
  qq: number,
  rawMsg: string,
): void {
  if (!groupCache.has(groupId)) {
    groupCache.set(groupId, []);
  }
  const cache = groupCache.get(groupId)!;
  cache.push(`${nick}（qq=${qq}）说：${rawMsg}`);
  if (cache.length > MAX_CACHE_SIZE) {
    cache.shift();
  }
}

function getGroupCacheSummary(groupId: number): string {
  const cache = groupCache.get(groupId);
  if (!cache || cache.length === 0) return "";
  return cache.slice(-10).join("\n");
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

/**
 * 统一入口：根据 message_type 分发到私聊或群聊处理。
 * 返回需要回复的文本，或 null 表示不回复。
 */
export async function dispatchMessage(event: RawMessageEvent): Promise<string | null> {
  if (event.message_type === "group") {
    return handleGroupMessage(event);
  }
  if (event.message_type === "private") {
    return handlePrivateMessage(event);
  }
  return null;
}

/**
 * 处理群聊消息。
 */
async function handleGroupMessage(
  event: RawMessageEvent,
): Promise<string | null> {
  const groupId = event.group_id!;
  const userId = event.user_id;

  // ---- 缓存消息 ----
  const nick = event.sender?.nickname ?? String(userId);
  const rawMsg = (event.raw_message ?? "").trim();
  addToGroupCache(groupId, nick, userId, rawMsg);

  // ---- 延长待处理的 @ 等待 ----
  const pending = pendingMentions.get(groupId);
  if (pending && pending.userId === userId) {
    pending.deadline = Math.max(pending.deadline, Date.now() + 5000);
  }

  // ---- 白名单校验 ----
  if (!isGroupWhitelisted(groupId)) {
    return null;
  }

  // ---- @ 检测 ----
  if (!isMentioned(event)) {
    return null;
  }

  const level = Math.max(getLevel(userId), 1) as 0 | 1 | 2 | 3;
  let msg = stripContent(event);

  // ---- 纯 @ 无文字：等对方说完 ----
  if (!msg) {
    // 设置等待，首次 10 秒
    const deadline = Date.now() + 10000;
    pendingMentions.set(groupId, { userId, deadline });

    await sleepUntilDeadline(groupId);

    // 被等待结束后，用群聊内容作为上下文
    msg = "请根据最近的群聊消息回复";
  }

  const { command, remaining } = resolveCommand(msg);
  if (!command) return null;

  // ---- 权限校验 ----
  if (level < command.minLevel) {
    return `权限不足。当前角色: ${LEVEL_LABELS[level]}(Lv${level})，${command.prefix ?? "默认"} 需要: ${LEVEL_LABELS[command.minLevel]}(Lv${command.minLevel})`;
  }

  return executeCommand(command, remaining, event);
}

/**
 * 处理私聊消息。
 */
async function handlePrivateMessage(
  event: RawMessageEvent,
): Promise<string | null> {
  const userId = event.user_id;
  const level = getLevel(userId);

  if (level === 0) {
    return "无权限";
  }

  const msg = (event.raw_message ?? "").trim();
  if (!msg) return null;

  const { command, remaining } = resolveCommand(msg);
  if (!command) return null;

  if (level < command.minLevel) {
    return `权限不足。当前角色: ${LEVEL_LABELS[level]}(Lv${level})，${command.prefix ?? "默认"} 需要: ${LEVEL_LABELS[command.minLevel]}(Lv${command.minLevel})`;
  }

  return executeCommand(command, remaining, event);
}

/**
 * 执行命令并处理回复。
 */
async function executeCommand(
  command: Command,
  remaining: string,
  event: RawMessageEvent,
): Promise<string | null> {
  const sKey = sessionKey(event);
  const sessionDir = getSessionDir(sKey);

  // ---- require_root 状态校验 ----
  if (command.requireRoot && !isRootMode(sKey)) {
    return `${command.prefix} 仅在 /root 模式下可用`;
  }

  const ctx = buildCtx(event, { sessionStore: _sessionStore ?? undefined, botNick: _botNick });

  try {
    const reply = await command.handler(remaining, sessionDir, ctx);

    // 默认对话：root 模式直接返回，普通模式检查 stdout 违规
    if (command.isDefault) {
      if (isRootMode(sKey)) {
        return reply && reply.trim() ? reply : null;
      }
      // 普通模式：若输出非 ok/空，说明违反了「最后一步——不要多写字」规则
      if (reply && reply.trim() && reply.trim() !== "ok") {
        // 重试一次
        const errPrompt = [
          "【错误】你违反了「最后一步——不要多写字」规则，在我这里输出了多余的文字。",
          "请先用 get_private_msg_history 或 get_group_msg_history 检查已经发出的消息，",
          "确认不要发重复内容，然后重新用 send_message 发送未发出的部分。",
          "全部发完之后，只输出 ok。",
        ].join("\n");
        const retry = await command.handler(
          `${remaining}\n\n${errPrompt}`,
          sessionDir,
          ctx,
        );
        if (retry && retry.trim() && retry.trim() !== "ok") {
          return `【stdout】${retry}`;
        }
      }
      return null;
    }

    return reply && reply.trim() ? reply : null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return "Claude Code 处理超时，请重试";
    }
    throw err;
  }
}

/**
 * 等待 pending mention 超时或被打断。
 */
async function sleepUntilDeadline(groupId: number): Promise<void> {
  // 每秒检查一次，确保 deadline 延长后能及时感知
  while (true) {
    const p = pendingMentions.get(groupId);
    if (!p) return;
    const remaining = p.deadline - Date.now();
    if (remaining <= 0) {
      pendingMentions.delete(groupId);
      return;
    }
    await new Promise(r => setTimeout(r, Math.min(remaining, 1000)));
  }
}

// ---------------------------------------------------------------------------
// Re-export for external use
// ---------------------------------------------------------------------------

export { handleGroupMessage, handlePrivateMessage, executeCommand, getGroupCacheSummary };
