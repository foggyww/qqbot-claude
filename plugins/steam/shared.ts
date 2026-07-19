import * as fs from "node:fs";
import * as path from "node:path";

import type { SteamSubscriptionMap, UserMappingEntry } from "../../src/core/types.js";

const BASE = "https://api.steampowered.com";
const STORE_SEARCH = "https://store.steampowered.com/api/storesearch";

export const STEAM_DATA_DIR = path.join(process.cwd(), "runtime", "data");
export const STEAM_SUBS_FILE = path.join(STEAM_DATA_DIR, "steam_subscriptions.json");
export const STEAM_STATE_FILE = path.join(STEAM_DATA_DIR, "steam_state.json");

export function ensureSteamDataDir(): void {
  fs.mkdirSync(STEAM_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STEAM_DATA_DIR, 0o700);
}

export function secureExistingSteamData(dataDir = STEAM_DATA_DIR): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  for (const name of ["steam_subscriptions.json", "steam_state.json"]) {
    const file = path.join(dataDir, name);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
}

export function writeSecureJson(file: string, data: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporaryFile, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
}

export function sanitizeExternalText(value: string): string {
  let sanitized = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = sanitized.replace(/(?:%[0-9a-f]{2})+/gi, (segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    if (decoded === sanitized) break;
    sanitized = decoded;
  }
  return sanitized
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/gi, "[redacted]")
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;}]+/gi, "authorization=[redacted]")
    .replace(/(["']?)(authorization|access[_-]?token|auth[_-]?token|key|token|api[_-]?key|cookie)\1\s*[:=]\s*(["'])[^"']*\3/gi, "$2=[redacted]")
    .replace(/\b(authorization|access[_-]?token|auth[_-]?token|key|token|api[_-]?key|cookie)\s*[:=]\s*[^\s&;,}]+/gi, "$1=[redacted]")
    .replace(/\b(?:authorization|access_token|auth_token|key|token|api_key|cookie)%3d[^&\s]+/gi, "credential%3D[redacted]")
    .slice(0, 300);
}

export function escapeOneBotText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SteamApiError {
  error: string;
  contentType?: string;
  body?: string;
}

export function apiKey(): string {
  return process.env.STEAM_WEB_API_KEY ?? process.env.STEAM_API_KEY ?? "";
}

export function steamIdsFromMapping(mapping: Partial<UserMappingEntry>): string[] {
  const ids: string[] = [];
  if (Array.isArray(mapping.steam_ids)) {
    ids.push(...mapping.steam_ids.map(String));
  }
  if (typeof mapping.steam_id === "string" && mapping.steam_id) {
    ids.push(mapping.steam_id);
  }
  if (typeof mapping.steam_alt === "string" && mapping.steam_alt) {
    ids.push(mapping.steam_alt);
  }
  return [...new Set(ids)];
}

export function parseSteamSubscriptions(value: unknown): SteamSubscriptionMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const subscriptions: SteamSubscriptionMap = {};
  for (const [groupId, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") {
      subscriptions[groupId] = { status: entry, weekly: false };
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fields = entry as Record<string, unknown>;
    subscriptions[groupId] = {
      status: fields.status === true,
      weekly: fields.weekly === true,
    };
  }
  return subscriptions;
}

export function loadSteamSubscriptions(): SteamSubscriptionMap {
  try {
    return parseSteamSubscriptions(JSON.parse(fs.readFileSync(STEAM_SUBS_FILE, "utf-8")) as unknown);
  } catch {
    return {};
  }
}

export function saveSteamSubscriptions(subscriptions: SteamSubscriptionMap): void {
  writeSecureJson(STEAM_SUBS_FILE, subscriptions);
}

export async function fetchSteam(pathname: string, keyOverride?: string): Promise<unknown> {
  const key = keyOverride ?? apiKey();
  if (!key) return { error: "未配置 STEAM_WEB_API_KEY，请在 .qqbotrc.toml 的 [env] 中设置" };
  const sep = pathname.includes("?") ? "&" : "?";
  const url = `${BASE}${pathname}${sep}key=${encodeURIComponent(key)}`;
  const response = await fetch(url, { headers: { "User-Agent": "qqbot/1.0" } });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    return {
      error: `Steam API HTTP ${response.status}`,
      contentType,
      body: sanitizeExternalText(text),
    } satisfies SteamApiError;
  }
  if (!contentType.includes("application/json")) {
    return {
      error: "Steam API 返回非 JSON 内容",
      contentType,
      body: sanitizeExternalText(text),
    } satisfies SteamApiError;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Steam API JSON 解析失败: ${msg}`,
      contentType,
      body: sanitizeExternalText(text),
    } satisfies SteamApiError;
  }
}

export async function fetchSteamStoreSearch(search: string): Promise<unknown> {
  const url = `${STORE_SEARCH}/?term=${encodeURIComponent(search)}&l=zh`;
  const response = await fetch(url, { headers: { "User-Agent": "qqbot/1.0" } });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    return {
      error: `Steam Store API HTTP ${response.status}`,
      contentType,
      body: sanitizeExternalText(text),
    } satisfies SteamApiError;
  }
  if (!contentType.includes("application/json")) {
    return {
      error: "Steam Store API 返回非 JSON 内容",
      contentType,
      body: sanitizeExternalText(text),
    } satisfies SteamApiError;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Steam Store API JSON 解析失败: ${msg}`,
      contentType,
      body: sanitizeExternalText(text),
    } satisfies SteamApiError;
  }
}

export function isSteamApiError(value: unknown): value is SteamApiError {
  return Boolean(value && typeof value === "object" && "error" in value);
}
