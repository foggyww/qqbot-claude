/** Steam 状态监控 —— 定时轮询 + 变更推送 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BotContext } from "../../src/core/types.js";
import { getUserMapping } from "../../src/core/user_mapping.js";

const STATE_FILE = path.join(process.cwd(), "data", "steam_state.json");
const SUBS_FILE = path.join(process.cwd(), "data", "steam_subscriptions.json");

let _ctx: BotContext | null = null;
let _apiKey = "";
let _timer: ReturnType<typeof setInterval> | null = null;
let _firstRun = true;
let _intervalMs = 300_000;

function loadJson(file: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return {}; }
}
function saveJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

export function initWatcher(ctx: BotContext, apiKey: string): void {
  _ctx = ctx;
  _apiKey = apiKey;
  _intervalMs = Math.max(ctx.config.steamWatcher.intervalMinutes, 1) * 60_000;
  const subs = loadJson(SUBS_FILE) as Record<string, boolean>;
  if (Object.values(subs).some(Boolean)) start();
}

function start(): void {
  if (_timer) return;
  _firstRun = true;
  _timer = setInterval(tick, _intervalMs);
}

export function stopWatcher(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function restartOrStop(): void {
  stopWatcher();
  const subs = loadJson(SUBS_FILE) as Record<string, boolean>;
  if (Object.values(subs).some(Boolean)) start();
}

export async function forceRefresh(_groupId: number): Promise<string | null> {
  void _groupId;
  if (!_ctx) return "watcher not initialized";
  _firstRun = false; // 手动刷新可以直接推送
  await doTick();
  return null;
}

async function tick(): Promise<void> {
  await doTick();
}

async function doTick(): Promise<void> {
  if (!_ctx || !_apiKey) return;

  const subs = loadJson(SUBS_FILE) as Record<string, boolean>;
  const activeGroups = Object.entries(subs).filter(([, v]) => v).map(([k]) => Number(k));
  if (!activeGroups.length) return;

  const oldState = loadJson(STATE_FILE) as Record<string, { name: string; online: boolean; game: string }>;
  const newState: Record<string, { name: string; online: boolean; game: string }> = {};

  for (const gid of activeGroups) {
    try {
      const members = await _ctx.adapter.getGroupMembers(gid);
      const sids: string[] = [];
      for (const member of members) {
        const mapping = getUserMapping(member.qq);
        const steamIds = mapping.steam_ids;
        if (Array.isArray(steamIds)) {
          sids.push(...steamIds.map(String));
        }
        if (typeof mapping.steam_id === "string") sids.push(mapping.steam_id);
        if (typeof mapping.steam_alt === "string") sids.push(mapping.steam_alt);
      }
      if (!sids.length) continue;

      const players = await fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${_apiKey}&steamids=${sids.join(",")}`);
      for (const p of (players as { response?: { players?: Array<{ steamid: string; personaname: string; personastate: number; gameextrainfo?: string }> } }).response?.players ?? []) {
        newState[p.steamid] = { name: p.personaname, online: p.personastate !== 0, game: p.gameextrainfo ?? "" };
      }
    } catch { /* skip failed groups */ }
  }

  saveJson(STATE_FILE, newState);
  if (_firstRun) { _firstRun = false; return; }

  for (const gid of activeGroups) {
    const changes: string[] = [];
    for (const [sid, cur] of Object.entries(newState)) {
      const prev = oldState[sid];
      if (!prev) continue;
      if (prev.online !== cur.online) {
        changes.push(cur.online ? `${cur.name} 上线了${cur.game ? ` 在玩 ${cur.game}` : ""}` : `${cur.name} 离线了`);
      } else if (cur.online && prev.game !== cur.game) {
        changes.push(cur.game ? `${cur.name} 开始玩 ${cur.game}` : `${cur.name} 退出游戏`);
      }
    }
    if (changes.length) {
      await _ctx.sendMessage("group", gid, "Steam 状态变更：\n" + changes.join("\n"));
    }
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return r.json();
}
