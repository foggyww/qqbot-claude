import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSteam,
  fetchSteamStoreSearch,
  STEAM_STATE_FILE,
  STEAM_SUBS_FILE,
  steamIdsFromMapping,
} from "../plugins/steam/shared.js";
import { getUserMapping, setMappingFile, setUserField } from "../src/core/user_mapping.js";

let originalFetch: typeof globalThis.fetch;
let originalSteamWebApiKey: string | undefined;
let originalSteamApiKey: string | undefined;
let originalCwd = "";
let tempRoot = "";

function mockResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalSteamWebApiKey = process.env.STEAM_WEB_API_KEY;
  originalSteamApiKey = process.env.STEAM_API_KEY;
  originalCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-steam-"));
  process.chdir(tempRoot);
  setMappingFile("");
  delete process.env.STEAM_WEB_API_KEY;
  delete process.env.STEAM_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSteamWebApiKey === undefined) delete process.env.STEAM_WEB_API_KEY;
  else process.env.STEAM_WEB_API_KEY = originalSteamWebApiKey;
  if (originalSteamApiKey === undefined) delete process.env.STEAM_API_KEY;
  else process.env.STEAM_API_KEY = originalSteamApiKey;
  setMappingFile("");
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Steam shared helpers", () => {
  it("keeps Steam plugin state under runtime/data", () => {
    expect(STEAM_SUBS_FILE).toContain(path.join("runtime", "data", "steam_subscriptions.json"));
    expect(STEAM_STATE_FILE).toContain(path.join("runtime", "data", "steam_state.json"));
    expect(path.basename(path.dirname(STEAM_SUBS_FILE))).toBe("data");
    expect(path.basename(path.dirname(path.dirname(STEAM_SUBS_FILE)))).toBe("runtime");
  });

  it("normalizes preferred and legacy Steam IDs", () => {
    expect(steamIdsFromMapping({ steam_ids: ["1", "2"], steam_id: "1", steam_alt: "3" })).toEqual(["1", "2", "3"]);
    expect(steamIdsFromMapping({ steam_id: "legacy-main", steam_alt: "legacy-alt" })).toEqual(["legacy-main", "legacy-alt"]);
  });

  it("returns structured error when API key is missing", async () => {
    await expect(fetchSteam("/ISteamUser/GetPlayerSummaries/v2/?steamids=1")).resolves.toEqual({
      error: "未配置 STEAM_WEB_API_KEY，请在 .qqbotrc.toml 的 [env] 中设置",
    });
  });

  it("returns structured error for HTTP errors", async () => {
    process.env.STEAM_WEB_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => mockResponse("denied", { status: 403, contentType: "text/plain" })) as typeof fetch;

    const result = await fetchSteam("/ISteamUser/GetPlayerSummaries/v2/?steamids=1");

    expect(result).toMatchObject({ error: "Steam API HTTP 403", contentType: "text/plain", body: "denied" });
  });

  it("returns structured error for non JSON responses", async () => {
    process.env.STEAM_WEB_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => mockResponse("<html></html>", { contentType: "text/html" })) as typeof fetch;

    const result = await fetchSteam("/ISteamUser/GetPlayerSummaries/v2/?steamids=1");

    expect(result).toMatchObject({ error: "Steam API 返回非 JSON 内容", contentType: "text/html" });
  });

  it("returns structured error for invalid JSON", async () => {
    process.env.STEAM_WEB_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => mockResponse("{", { contentType: "application/json" })) as typeof fetch;

    const result = await fetchSteam("/ISteamUser/GetPlayerSummaries/v2/?steamids=1");

    expect(result).toMatchObject({ contentType: "application/json", body: "{" });
    expect((result as { error: string }).error).toContain("Steam API JSON 解析失败");
  });

  it("returns parsed JSON and encodes the API key", async () => {
    process.env.STEAM_WEB_API_KEY = "key&with=symbols";
    const fetchMock = vi.fn(async () => mockResponse(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchSteam("/ISteamUser/GetPlayerSummaries/v2/?steamids=1");

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("key=key%26with%3Dsymbols");
  });

  it("handles Steam store search errors with the same structure", async () => {
    globalThis.fetch = vi.fn(async () => mockResponse("nope", { status: 500, contentType: "text/plain" })) as typeof fetch;

    const result = await fetchSteamStoreSearch("test");

    expect(result).toMatchObject({ error: "Steam Store API HTTP 500", contentType: "text/plain", body: "nope" });
  });
});

describe("user mapping Steam schema", () => {
  it("reads and writes mappings under runtime/data by default", () => {
    setUserField(123, "steam_ids", ["765"]);

    const file = path.join(tempRoot, "runtime", "data", "user_mapping.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, "data", "user_mapping.json"))).toBe(false);
    expect(getUserMapping(123).steam_ids).toEqual(["765"]);
  });

  it("returns an empty mapping when the file is missing", () => {
    expect(getUserMapping(404)).toEqual({});
  });
});
