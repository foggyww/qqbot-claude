import * as path from "node:path";

import type { UserMappingEntry } from "../../src/core/types.js";

const BASE = "https://api.steampowered.com";
const STORE_SEARCH = "https://store.steampowered.com/api/storesearch";

export const STEAM_DATA_DIR = path.join(process.cwd(), "runtime", "data");
export const STEAM_SUBS_FILE = path.join(STEAM_DATA_DIR, "steam_subscriptions.json");
export const STEAM_STATE_FILE = path.join(STEAM_DATA_DIR, "steam_state.json");

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
      body: text.slice(0, 300),
    } satisfies SteamApiError;
  }
  if (!contentType.includes("application/json")) {
    return {
      error: "Steam API 返回非 JSON 内容",
      contentType,
      body: text.slice(0, 300),
    } satisfies SteamApiError;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Steam API JSON 解析失败: ${msg}`,
      contentType,
      body: text.slice(0, 300),
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
      body: text.slice(0, 300),
    } satisfies SteamApiError;
  }
  if (!contentType.includes("application/json")) {
    return {
      error: "Steam Store API 返回非 JSON 内容",
      contentType,
      body: text.slice(0, 300),
    } satisfies SteamApiError;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Steam Store API JSON 解析失败: ${msg}`,
      contentType,
      body: text.slice(0, 300),
    } satisfies SteamApiError;
  }
}

export function isSteamApiError(value: unknown): value is SteamApiError {
  return Boolean(value && typeof value === "object" && "error" in value);
}
