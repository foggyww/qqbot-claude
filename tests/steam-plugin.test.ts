import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSteam,
  fetchSteamStoreSearch,
  STEAM_SETTINGS_FILE,
  STEAM_STATE_FILE,
  STEAM_SUBS_FILE,
  parseSteamSubscriptions,
  parseSteamSettings,
  areSteamNotificationsEnabled,
  sanitizeExternalText,
  secureExistingSteamData,
  steamIdsFromMapping,
  setSteamNotificationsEnabled,
  writeSecureJson,
} from "../plugins/steam/shared.js";
import { getUserMapping, secureUserMappingFile, setMappingFile, setUserField } from "../src/core/user_mapping.js";
import {
  buildWatcherNotification,
  formatWatcherChanges,
  parseWatcherPlayers,
  preserveWatcherGroupState,
  runManualWatcherRefresh,
  runWatcherTickSafely,
  sendWatcherNotifications,
} from "../plugins/steam/watcher.js";
import { createSteamMcpServer } from "../plugins/steam/mcp-server.js";
import { handleSteamCommand, handleSteamNotifyCommand, steamCommands } from "../plugins/steam/commands.js";
import type { MessageContext } from "../src/core/types.js";

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
    expect(STEAM_SETTINGS_FILE).toContain(path.join("runtime", "data", "steam_settings.json"));
    expect(path.basename(path.dirname(STEAM_SUBS_FILE))).toBe("data");
    expect(path.basename(path.dirname(path.dirname(STEAM_SUBS_FILE)))).toBe("runtime");
  });

  it("normalizes preferred and legacy Steam IDs", () => {
    expect(steamIdsFromMapping({ steam_ids: ["1", "2"], steam_id: "1", steam_alt: "3" })).toEqual(["1", "2", "3"]);
    expect(steamIdsFromMapping({ steam_id: "legacy-main", steam_alt: "legacy-alt" })).toEqual(["legacy-main", "legacy-alt"]);
  });

  it("migrates legacy status subscriptions without enabling weekly reports", () => {
    expect(parseSteamSubscriptions({ "123": true, "456": { status: false, weekly: true } })).toEqual({
      "123": { status: true, weekly: false },
      "456": { status: false, weekly: true },
    });
  });

  it("defaults realtime notifications to enabled and persists the global switch", () => {
    const file = path.join(tempRoot, "runtime", "data", "steam_settings.json");
    expect(parseSteamSettings(null)).toEqual({ notificationsEnabled: true });
    expect(parseSteamSettings({ notificationsEnabled: false })).toEqual({ notificationsEnabled: false });
    expect(areSteamNotificationsEnabled(file)).toBe(true);

    setSteamNotificationsEnabled(false, file);

    expect(areSteamNotificationsEnabled(file)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writes private runtime JSON and redacts external error summaries", () => {
    const dir = path.join(tempRoot, "private-data");
    const file = path.join(dir, "state.json");
    writeSecureJson(file, { ok: true });

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(sanitizeExternalText("token=secret-value cookie:session-value sk-1234567890abcdef")).toBe(
      "token=[redacted] cookie=[redacted] [redacted]",
    );
    expect(sanitizeExternalText('{"token":"secret","api_key":"private"} Authorization: Bearer bearer-secret')).toBe(
      "{token=[redacted],api_key=[redacted]} authorization=[redacted]",
    );
    expect(sanitizeExternalText('{"Authorization":"Bearer live-secret","access_token":"private","auth_token":"hidden"}')).toBe(
      "{Authorization=[redacted],access_token=[redacted],auth_token=[redacted]}",
    );
    expect(sanitizeExternalText("Authorization%3A%20Bearer%20url-secret")).toBe("authorization=[redacted]");
    expect(sanitizeExternalText("%7B%22access_token%22%3A%22url-json-secret%22%7D")).toBe("{access_token=[redacted]}");
    expect(sanitizeExternalText("Authorization%253A%2520Bearer%2520double-secret")).toBe("authorization=[redacted]");
    expect(sanitizeExternalText("bad%ZZ Authorization%3A%20Bearer%20mixed-secret")).toBe("bad%ZZ authorization=[redacted]");
    expect(sanitizeExternalText("%257B%2522token%2522%253A%2522double-json-secret%2522%257D")).toBe("{token=[redacted]}");
  });

  it("tightens permissions on existing Steam runtime data", () => {
    const dataDir = path.join(tempRoot, "runtime", "data");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    const file = path.join(dataDir, "steam_state.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });

    secureExistingSteamData(dataDir);

    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
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

  it("limits streamed response size and handles network failures without exposing URLs", async () => {
    process.env.STEAM_WEB_API_KEY = "private-test-key";
    globalThis.fetch = vi.fn(async () => mockResponse("x".repeat(4 * 1024 * 1024 + 1))) as typeof fetch;
    expect(await fetchSteam("/test")).toEqual({ error: "Steam API 请求失败、超时或响应过大" });
    globalThis.fetch = vi.fn(async () => { throw new Error("URL contained private-test-key"); }) as typeof fetch;
    const result = await fetchSteam("/test");
    expect(JSON.stringify(result)).not.toContain("private-test-key");
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("provides an abort deadline that also covers response body reads", async () => {
    process.env.STEAM_WEB_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return mockResponse('{}');
    });
    globalThis.fetch = fetchMock as typeof fetch;
    expect(await fetchSteam("/test")).toEqual({});
  });
});

describe("user mapping Steam schema", () => {
  it("reads and writes mappings under runtime/data by default", () => {
    setUserField(123, "steam_ids", ["765"]);

    const file = path.join(tempRoot, "runtime", "data", "user_mapping.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, "data", "user_mapping.json"))).toBe(false);
    expect(getUserMapping(123).steam_ids).toEqual(["765"]);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tightens permissions for an existing user mapping file", () => {
    const dir = path.join(tempRoot, "mapping-data");
    const file = path.join(dir, "user_mapping.json");
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, "{}", { mode: 0o644 });

    secureUserMappingFile(file);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("returns an empty mapping when the file is missing", () => {
    expect(getUserMapping(404)).toEqual({});
  });
});

describe("Steam watcher message safety", () => {
  it("compares one group at a time and escapes untrusted CQ text", () => {
    const changes = formatWatcherChanges(
      { "1": { name: "old", online: false, game: "" } },
      { "1": { name: "[CQ:at,qq=all]", online: true, game: "[CQ:image,file=x]" } },
    );

    expect(changes).toEqual([
      "&#91;CQ:at,qq=all&#93; 上线了 在玩 &#91;CQ:image,file=x&#93;",
    ]);
    expect(formatWatcherChanges({}, { "1": { name: "other group", online: true, game: "" } })).toEqual([]);
  });

  it("preserves a group's previous state when collection fails", () => {
    const previous = { "1": { name: "player", online: false, game: "" } };
    expect(preserveWatcherGroupState(previous, null)).toBe(previous);
    expect(preserveWatcherGroupState(previous, {})).toEqual({});
  });

  it("skips a pending state notification while the global switch is off", () => {
    const previous = { "1": { name: "player", online: false, game: "" } };
    const current = { "1": { name: "player", online: true, game: "Game" } };

    expect(buildWatcherNotification(previous, current, false)).toBeNull();
    expect(buildWatcherNotification(previous, current, true)).toContain("player 上线了 在玩 Game");
  });

  it("rejects malformed player JSON instead of clearing group state", () => {
    expect(parseWatcherPlayers({ response: {} })).toBeNull();
    expect(parseWatcherPlayers({ response: { players: [{ steamid: "1", personaname: "name" }] } })).toBeNull();
    expect(parseWatcherPlayers({
      response: { players: [{ steamid: "1", personaname: "name", personastate: 1, gameextrainfo: "game" }] },
    })).toEqual({ "1": { name: "name", online: true, game: "game" } });
  });

  it("continues notifying other groups when one group send fails", async () => {
    const offline = { "1": { name: "player", online: false, game: "" } };
    const online = { "1": { name: "player", online: true, game: "Game" } };
    const sendMessage = vi.fn(async (_type: "private" | "group", groupId: number) => {
      if (groupId === 100) throw new Error("OneBot retcode=1200");
    });
    const warn = vi.fn();

    await expect(sendWatcherNotifications(
      [100, 200],
      { "100": offline, "200": offline },
      { "100": online, "200": online },
      true,
      sendMessage,
      warn,
    )).resolves.toBe(1);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, "group", 200, expect.stringContaining("player 上线了"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("群 100 通知发送失败: OneBot retcode=1200"));
  });

  it("contains rejected periodic ticks even when logging also fails", async () => {
    const runTick = vi.fn(async () => { throw new Error("state write failed"); });
    const warn = vi.fn(() => { throw new Error("logger failed"); });

    await expect(runWatcherTickSafely(runTick, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Steam watcher 定时刷新失败: state write failed");
  });

  it("returns diagnostic results for manual refresh failures", async () => {
    const warn = vi.fn();

    await expect(runManualWatcherRefresh(async () => 2, warn)).resolves.toBe(
      "Steam watcher 刷新完成，但 2 个群通知发送失败，请检查日志",
    );
    await expect(runManualWatcherRefresh(async () => {
      throw new Error("token=secret-value state write failed");
    }, warn)).resolves.toBe("Steam watcher 刷新失败: token=[redacted] state write failed");
    expect(warn).toHaveBeenCalledWith("Steam watcher 手动刷新失败: token=[redacted] state write failed");
  });
});

describe("Steam recent ranking entry points", () => {
  it("publishes the current group from the command without returning a duplicate reply", async () => {
    const publish = vi.fn(async () => ({ ok: true, leaderboardSent: true }));
    const ctx = { replyType: "group", replyId: 123 } as MessageContext;

    await expect(handleSteamCommand("recent", "/tmp/session", ctx, publish)).resolves.toBeUndefined();
    await expect(handleSteamCommand("2weeks", "/tmp/session", ctx, publish)).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledWith(123);
  });

  it("returns a friendly command error for structured publication failures", async () => {
    const publish = vi.fn(async () => ({
      ok: false,
      code: "COLLECTION_FAILED" as const,
      error: "获取群成员或绑定信息失败",
      leaderboardSent: false,
      roastSentCount: 0,
    }));
    const ctx = { replyType: "group", replyId: 123 } as MessageContext;

    await expect(handleSteamCommand("recent", "/tmp/session", ctx, publish)).resolves.toBe(
      "生成 Steam 最近两周榜失败：获取群成员或绑定信息失败",
    );
  });

  it("exposes an MCP tool with explicit side effects and validates group_id", async () => {
    const publish = vi.fn(async (groupId: number) => ({ ok: true, groupId, leaderboardSent: true }));
    const server = createSteamMcpServer(publish);
    const tool = server.tools.find((item) => item.name === "steam_publish_group_recent_ranking");

    expect(tool?.inputSchema.required).toEqual(["group_id"]);
    await expect(server.handleToolCall("steam_publish_group_recent_ranking", { group_id: "123" })).resolves.toMatchObject({
      ok: false,
      code: "INVALID_GROUP_ID",
    });
    await expect(server.handleToolCall("steam_publish_group_recent_ranking", { group_id: 123 })).resolves.toMatchObject({
      ok: true,
      groupId: 123,
    });
    expect(publish).toHaveBeenCalledWith(123);
  });

  it("preserves structured publication failures through MCP", async () => {
    const publish = vi.fn(async () => ({
      ok: false,
      code: "LEADERBOARD_SEND_FAILED" as const,
      error: "发送最近两周榜单失败",
      leaderboardSent: false,
      roastSentCount: 0,
    }));
    const server = createSteamMcpServer(publish);

    await expect(server.handleToolCall("steam_publish_group_recent_ranking", { group_id: 123 })).resolves.toEqual({
      ok: false,
      code: "LEADERBOARD_SEND_FAILED",
      error: "发送最近两周榜单失败",
      leaderboardSent: false,
      roastSentCount: 0,
    });
  });
});

describe("Steam global realtime notification command", () => {
  it("is registered as a level 3 subcommand so the router enforces administrator access", () => {
    expect(steamCommands.find((command) => command.prefix === "/steam notify")).toMatchObject({ minLevel: 3 });
    expect(steamCommands.find((command) => command.prefix === "/steam")).toMatchObject({ minLevel: 2 });
  });

  it("toggles all realtime notifications without requiring a group context", async () => {
    let enabled = true;
    const setEnabled = vi.fn((value: boolean) => { enabled = value; });
    const getEnabled = vi.fn(() => enabled);

    await expect(handleSteamNotifyCommand("off", setEnabled, getEnabled)).resolves.toBe(
      "已关闭全部 Steam 上下线及游戏状态通知",
    );
    await expect(handleSteamNotifyCommand("status", setEnabled, getEnabled)).resolves.toBe(
      "Steam 上下线及游戏状态通知: 已关闭",
    );
    await expect(handleSteamNotifyCommand("on", setEnabled, getEnabled)).resolves.toBe(
      "已开启全部 Steam 上下线及游戏状态通知",
    );
    expect(setEnabled).toHaveBeenNthCalledWith(1, false);
    expect(setEnabled).toHaveBeenNthCalledWith(2, true);
  });
});
