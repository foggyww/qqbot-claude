/** Steam 状态监控 —— 定时轮询 + 变更推送 */
import * as fs from "node:fs";
import type { BotContext } from "../../src/core/types.js";
import { getUserMapping } from "../../src/core/user_mapping.js";
import {
  areSteamNotificationsEnabled,
  escapeOneBotText,
  fetchSteam,
  isSteamApiError,
  sanitizeExternalText,
  STEAM_STATE_FILE,
  loadSteamSubscriptions,
  steamIdsFromMapping,
  writeSecureJson,
} from "./shared.js";

const STATE_FILE = STEAM_STATE_FILE;
let _ctx: BotContext | null = null;
let _apiKey = "";
let _timer: ReturnType<typeof setInterval> | null = null;
let _firstRun = true;
let _intervalMs = 300_000;

function loadJson(file: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return {}; }
}
function saveJson(file: string, data: unknown): void {
  writeSecureJson(file, data);
}

interface WatcherPlayerState {
  name: string;
  online: boolean;
  game: string;
}

type WatcherGroupState = Record<string, WatcherPlayerState>;
type WatcherState = Record<string, WatcherGroupState>;

function errorMessage(error: unknown): string {
  return sanitizeExternalText(error instanceof Error ? error.message : String(error));
}

function warnSafely(warn: (message: string) => void, message: string): void {
  try {
    warn(message);
  } catch {
    // Logging must never turn a handled watcher failure into an unhandled rejection.
  }
}

function loadWatcherState(): WatcherState {
  const value = loadJson(STATE_FILE);
  for (const group of Object.values(value)) {
    if (!group || typeof group !== "object" || Array.isArray(group) || "name" in group) return {};
  }
  return value as WatcherState;
}

export function formatWatcherChanges(previous: WatcherGroupState, current: WatcherGroupState): string[] {
  const changes: string[] = [];
  for (const [steamId, player] of Object.entries(current)) {
    const prior = previous[steamId];
    if (!prior) continue;
    const name = escapeOneBotText(player.name);
    const game = escapeOneBotText(player.game);
    if (prior.online !== player.online) {
      changes.push(player.online ? `${name} 上线了${game ? ` 在玩 ${game}` : ""}` : `${name} 离线了`);
    } else if (player.online && prior.game !== player.game) {
      changes.push(game ? `${name} 开始玩 ${game}` : `${name} 退出游戏`);
    }
  }
  return changes;
}

export function buildWatcherNotification(
  previous: WatcherGroupState,
  current: WatcherGroupState,
  notificationsEnabled: boolean,
): string | null {
  if (!notificationsEnabled) return null;
  const changes = formatWatcherChanges(previous, current);
  return changes.length ? "Steam 状态变更：\n" + changes.join("\n") : null;
}

export function preserveWatcherGroupState(
  previous: WatcherGroupState,
  collected: WatcherGroupState | null,
): WatcherGroupState {
  return collected ?? previous;
}

export function parseWatcherPlayers(value: unknown): WatcherGroupState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = (value as Record<string, unknown>).response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const players = (response as Record<string, unknown>).players;
  if (!Array.isArray(players)) return null;

  const state: WatcherGroupState = {};
  for (const value of players) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const player = value as Record<string, unknown>;
    if (typeof player.steamid !== "string" || !player.steamid) return null;
    if (typeof player.personaname !== "string") return null;
    if (typeof player.personastate !== "number" || !Number.isInteger(player.personastate)) return null;
    if (player.gameextrainfo !== undefined && typeof player.gameextrainfo !== "string") return null;
    state[player.steamid] = {
      name: player.personaname,
      online: player.personastate !== 0,
      game: player.gameextrainfo ?? "",
    };
  }
  return state;
}

export function initWatcher(ctx: BotContext, apiKey: string): void {
  _ctx = ctx;
  _apiKey = apiKey;
  _intervalMs = Math.max(ctx.config.steamWatcher.intervalMinutes, 1) * 60_000;
  const subs = loadSteamSubscriptions();
  if (Object.values(subs).some((subscription) => subscription.status)) start();
}

function start(): void {
  if (_timer) return;
  _firstRun = true;
  _timer = setInterval(() => {
    void tick();
  }, _intervalMs);
}

export function stopWatcher(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function restartOrStop(): void {
  stopWatcher();
  const subs = loadSteamSubscriptions();
  if (Object.values(subs).some((subscription) => subscription.status)) start();
}

export async function forceRefresh(_groupId: number): Promise<string | null> {
  void _groupId;
  if (!_ctx) return "watcher not initialized";
  _firstRun = false; // 手动刷新可以直接推送
  return runManualWatcherRefresh(doTick, _ctx.logger.warn.bind(_ctx.logger));
}

export async function runManualWatcherRefresh(
  runTick: () => Promise<number>,
  warn: (message: string) => void,
): Promise<string | null> {
  try {
    const failedNotifications = await runTick();
    return failedNotifications > 0
      ? `Steam watcher 刷新完成，但 ${failedNotifications} 个群通知发送失败，请检查日志`
      : null;
  } catch (error) {
    const message = errorMessage(error);
    warnSafely(warn, `Steam watcher 手动刷新失败: ${message}`);
    return `Steam watcher 刷新失败: ${message}`;
  }
}

async function tick(): Promise<void> {
  if (!_ctx) return;
  await runWatcherTickSafely(doTick, _ctx.logger.warn.bind(_ctx.logger));
}

export async function runWatcherTickSafely(
  runTick: () => Promise<unknown>,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await runTick();
  } catch (error) {
    warnSafely(warn, `Steam watcher 定时刷新失败: ${errorMessage(error)}`);
  }
}

export async function sendWatcherNotifications(
  activeGroups: number[],
  oldState: WatcherState,
  newState: WatcherState,
  notificationsEnabled: boolean,
  sendMessage: BotContext["sendMessage"],
  warn: (message: string) => void,
): Promise<number> {
  let failedNotifications = 0;
  for (const gid of activeGroups) {
    const notification = buildWatcherNotification(
      oldState[String(gid)] ?? {},
      newState[String(gid)] ?? {},
      notificationsEnabled,
    );
    if (!notification) continue;
    try {
      await sendMessage("group", gid, notification);
    } catch (error) {
      failedNotifications += 1;
      warnSafely(warn, `Steam watcher 群 ${gid} 通知发送失败: ${errorMessage(error)}`);
    }
  }
  return failedNotifications;
}

async function doTick(): Promise<number> {
  if (!_ctx || !_apiKey) return 0;

  const subs = loadSteamSubscriptions();
  const activeGroups = Object.entries(subs).filter(([, subscription]) => subscription.status).map(([k]) => Number(k));
  if (!activeGroups.length) return 0;

  const oldState = loadWatcherState();
  const newState: WatcherState = {};

  for (const gid of activeGroups) {
    const groupState: WatcherGroupState = {};
    try {
      const members = await _ctx.adapter.getGroupMembers(gid);
      const sids: string[] = [];
      for (const member of members) {
        const mapping = getUserMapping(member.qq);
        sids.push(...steamIdsFromMapping(mapping));
      }
      if (!sids.length) {
        newState[String(gid)] = groupState;
        continue;
      }

      const players = await fetchSteam(`/ISteamUser/GetPlayerSummaries/v2/?steamids=${sids.map(encodeURIComponent).join(",")}`, _apiKey);
      if (isSteamApiError(players)) {
        _ctx.logger.warn(`Steam watcher 查询失败: ${players.error}`);
        newState[String(gid)] = preserveWatcherGroupState(oldState[String(gid)] ?? {}, null);
        continue;
      }
      const parsedPlayers = parseWatcherPlayers(players);
      if (parsedPlayers === null) {
        _ctx.logger.warn(`Steam watcher 群 ${gid} 返回结构无效，保留旧状态`);
        newState[String(gid)] = preserveWatcherGroupState(oldState[String(gid)] ?? {}, null);
        continue;
      }
      newState[String(gid)] = parsedPlayers;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      _ctx.logger.warn(`Steam watcher 跳过群 ${gid}: ${msg}`);
      newState[String(gid)] = preserveWatcherGroupState(oldState[String(gid)] ?? {}, null);
    }
  }

  saveJson(STATE_FILE, newState);
  if (_firstRun) { _firstRun = false; return 0; }

  return sendWatcherNotifications(
    activeGroups,
    oldState,
    newState,
    areSteamNotificationsEnabled(),
    _ctx.sendMessage,
    _ctx.logger.warn.bind(_ctx.logger),
  );
}
