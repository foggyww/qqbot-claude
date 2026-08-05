import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  calculateRecentRanking,
  assignDuplicateSteamIds,
  deliverWeeklyReport,
  formatDuration,
  formatRecentReport,
  initWeekly,
  isRecentGamesUnavailable,
  loadWeeklyRoastPrompt,
  parseRecentGames,
  parseRoastLines,
  publishRecentTwoWeekRanking,
  publishSubscribedRecentRankings,
  stopWeekly,
  trackRecentPublication,
  waitForRecentPublications,
  type SteamAccountSnapshots,
  type WeeklyParticipant,
} from "../plugins/steam/weekly.js";
import { setMappingFile } from "../src/core/user_mapping.js";
import type { BotContext } from "../src/core/types.js";

const participants: WeeklyParticipant[] = [
  { qq: 1, displayName: "甲", steamIds: ["steam-a", "steam-b"] },
  { qq: 2, displayName: "乙", steamIds: ["steam-c"] },
];

describe("Steam weekly ranking", () => {
  it("assigns a Steam ID bound to multiple QQ users once, deterministically", () => {
    expect(assignDuplicateSteamIds([
      { qq: 20, displayName: "乙", steamIds: ["shared", "own-b"] },
      { qq: 10, displayName: "甲", steamIds: ["shared", "own-a"] },
    ])).toEqual([
      { qq: 20, displayName: "乙", steamIds: ["own-b"] },
      { qq: 10, displayName: "甲", steamIds: ["shared", "own-a"] },
    ]);
  });

  it("formats Steam minute precision for display", () => {
    expect(formatDuration(25)).toBe("25m");
    expect(formatDuration(1676)).toBe("27h56m");
    expect(formatDuration(120)).toBe("2h");
  });

});

describe("Steam recent two-week ranking", () => {
  it("parses strict playtime_2weeks responses", () => {
    expect(parseRecentGames({ response: { total_count: 0 } })).toEqual({});
    expect(parseRecentGames({ response: { total_count: 0, games: [] } })).toEqual({});
    expect(parseRecentGames({
      response: {
        total_count: 2,
        games: [
          { appid: 10, name: "Game A", playtime_2weeks: 35 },
          { appid: 20, name: "Game B", playtime_2weeks: 0 },
        ],
      },
    })).toEqual({
      "10": { name: "Game A", minutes: 35 },
      "20": { name: "Game B", minutes: 0 },
    });
    expect(parseRecentGames({ response: { total_count: 1, games: [{ appid: 10 }] } })).toBeNull();
    expect(parseRecentGames({ response: { total_count: "1", games: [] } })).toBeNull();
    expect(parseRecentGames({
      response: {
        total_count: 2,
        games: [{ appid: 10, name: "Game A", playtime_2weeks: 35 }],
      },
    })).toEqual({ "10": { name: "Game A", minutes: 35 } });
    expect(parseRecentGames({ response: { total_count: 1, games: [] } })).toEqual({});
    expect(parseRecentGames({
      response: {
        total_count: 1,
        games: [
          { appid: 10, playtime_2weeks: 1 },
          { appid: 20, playtime_2weeks: 1 },
        ],
      },
    })).toBeNull();
    expect(parseRecentGames({ response: { total_count: 1, games: [{ appid: 10, playtime_2weeks: -1 }] } })).toBeNull();
    expect(parseRecentGames({ response: { total_count: 1, games: [{ appid: 10, playtime_2weeks: 1.5 }] } })).toBeNull();
    expect(isRecentGamesUnavailable({ response: {} })).toBe(true);
    expect(isRecentGamesUnavailable({ response: { total_count: 0 } })).toBe(false);
    expect(isRecentGamesUnavailable({ error: "Steam API HTTP 500" })).toBe(false);
  });

  it("waits for active publications before shutdown completes", async () => {
    let resolvePublication: ((value: { ok: boolean }) => void) | undefined;
    const publication = new Promise<{ ok: boolean }>((resolve) => { resolvePublication = resolve; });
    trackRecentPublication(publication);
    let completed = false;
    const waiting = waitForRecentPublications().then(() => { completed = true; });

    await Promise.resolve();
    expect(completed).toBe(false);
    resolvePublication?.({ ok: true });
    await waiting;
    expect(completed).toBe(true);
  });

  it("ranks each player's game time while merging that player's Steam accounts", () => {
    const snapshots: SteamAccountSnapshots = {
      "steam-a": { "10": { name: "Game A", minutes: 30 } },
      "steam-b": { "10": { name: "Game A", minutes: 20 } },
      "steam-c": {
        "10": { name: "Game A", minutes: 10 },
        "20": { name: "Game B", minutes: 40 },
      },
    };

    expect(calculateRecentRanking(participants, snapshots)).toEqual([
      { appId: 10, name: "Game A", minutes: 50, playerQq: 1, playerName: "甲" },
      { appId: 20, name: "Game B", minutes: 40, playerQq: 2, playerName: "乙" },
      { appId: 10, name: "Game A", minutes: 10, playerQq: 2, playerName: "乙" },
    ]);
  });

  it("uses QQ number and app ID as deterministic tie-breakers", () => {
    const tiedParticipants: WeeklyParticipant[] = [
      { qq: 2, displayName: "乙", steamIds: ["steam-b"] },
      { qq: 1, displayName: "甲", steamIds: ["steam-a"] },
    ];
    const snapshots: SteamAccountSnapshots = {
      "steam-a": {
        "20": { name: "Game B", minutes: 30 },
        "10": { name: "Game A", minutes: 30 },
      },
      "steam-b": { "5": { name: "Game C", minutes: 30 } },
    };

    expect(calculateRecentRanking(tiedParticipants, snapshots).map((entry) => [entry.playerQq, entry.appId])).toEqual([
      [1, 10],
      [1, 20],
      [2, 5],
    ]);
  });

  it("formats compact ranking rows and escapes untrusted game and player names", () => {
    const report = formatRecentReport(
      new Date("2026-07-19T12:00:00Z"),
      [{ appId: 1, name: "[CQ:at,qq=all]", minutes: 1676, playerQq: 1, playerName: "[CQ:image,file=x]" }],
      0,
      0,
      true,
    );
    expect(report).toContain("1. &#91;CQ:image,file=x&#93;｜&#91;CQ:at,qq=all&#93;｜27h56m");
    expect(report).toContain("&#91;CQ:at,qq=all&#93;");
    expect(report).toContain("&#91;CQ:image,file=x&#93;");
    expect(report).not.toContain("[CQ:");
  });

  it("reports unavailable accounts separately from request failures", () => {
    const report = formatRecentReport(new Date("2026-07-19T12:00:00Z"), [], 1, 2, true);

    expect(report).toContain("另有 2 个 Steam 账号的游戏详情不可见，未计入本次榜单。");
    expect(report).toContain("另有 1 个 Steam 账号数据获取失败，未计入本次榜单。");
  });

  it("schedules only weekly subscribers through the shared publisher", async () => {
    const publish = vi.fn(async (groupId: number) => ({ ok: true, groupId, leaderboardSent: true, roastSentCount: 0 }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await publishSubscribedRecentRankings({
      "1": { status: false, weekly: true },
      "2": { status: true, weekly: false },
    }, publish, logger);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(1);
  });
});

describe("Steam recent publisher validation", () => {
  function botContext(overrides: Partial<BotContext> = {}): BotContext {
    return {
      config: {
        qq: { account: 1 },
        onebot: { wsUrl: "ws://127.0.0.1:3000" },
        paths: {
          sessionsDir: "/tmp/sessions",
          projectsDir: "/tmp/projects",
          workspaceDir: "/tmp/workspace",
          projectDir: "/tmp/project",
          rootProjectsDir: "/tmp/root-projects",
        },
        env: {}, run: { useSudo: false }, models: { default: "flash", flash: "flash" },
        efforts: { default: "high" }, settings: { timeout: 1, noPermissionReply: "无权限" },
        roles: {}, groupWhitelist: [10], tools: [], prompt: { masterQq: 0 },
        steamWatcher: { intervalMinutes: 5, weeklyReportCron: "0 12 * * 0" },
      },
      sessionDir: "/tmp/sessions",
      adapter: {
        start: vi.fn(), stop: vi.fn(), onMessage: vi.fn(), sendPrivateMsg: vi.fn(), sendGroupMsg: vi.fn(),
        getGroupList: vi.fn(), getGroupMembers: vi.fn(async () => []), getGroupMsgHistory: vi.fn(),
        getPrivateMsgHistory: vi.fn(), getStrangerInfo: vi.fn(), deleteMsg: vi.fn(),
      },
      sessionStore: {
        loadModel: vi.fn(), saveModel: vi.fn(), loadEffort: vi.fn(), saveEffort: vi.fn(),
        isRootMode: vi.fn(), setRootMode: vi.fn(), setChatMode: vi.fn(), getSessionId: vi.fn(),
      },
      sendMessage: vi.fn(async () => {}),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      scheduler: { addJob: vi.fn(), removeJob: vi.fn(), getJob: vi.fn() },
      ...overrides,
    };
  }

  it("returns complete side-effect fields for validation failures", async () => {
    const ctx = botContext();
    initWeekly(ctx, "test-key");
    try {
      await expect(publishRecentTwoWeekRanking(20)).resolves.toMatchObject({
        ok: false,
        code: "GROUP_NOT_ALLOWED",
        leaderboardSent: false,
        roastSentCount: 0,
      });
    } finally {
      await stopWeekly(ctx);
    }
  });

  it("returns a structured collection failure from the real publisher", async () => {
    const ctx = botContext({
      adapter: { ...botContext().adapter, getGroupMembers: vi.fn(async () => { throw new Error("OneBot down"); }) },
    });
    initWeekly(ctx, "test-key");
    setMappingFile("");
    try {
      await expect(publishRecentTwoWeekRanking(10)).resolves.toMatchObject({
        ok: false,
        code: "COLLECTION_FAILED",
        leaderboardSent: false,
        roastSentCount: 0,
      });
    } finally {
      await stopWeekly(ctx);
    }
  });

  it("treats a valid empty partial response as collected data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-steam-weekly-"));
    const mappingFile = path.join(dir, "user_mapping.json");
    fs.writeFileSync(mappingFile, JSON.stringify({ users: { "1": { steam_id: "steam-a" } } }), "utf-8");
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      response: { total_count: 1, games: [] },
    }), { headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as typeof fetch;
    const sendMessage = vi.fn(async () => {});
    const ctx = botContext({
      adapter: {
        ...botContext().adapter,
        getGroupMembers: vi.fn(async () => [{ qq: 1, nick: "甲", card: "" }]),
      },
      sendMessage,
    });
    initWeekly(ctx, "test-key");
    setMappingFile(mappingFile);
    try {
      await expect(publishRecentTwoWeekRanking(10)).resolves.toMatchObject({
        ok: true,
        failedAccountCount: 0,
        unavailableAccountCount: 0,
        empty: true,
      });
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("count=0");
      expect(sendMessage).toHaveBeenCalledWith(
        "group",
        10,
        expect.stringContaining("最近两周暂无游玩记录"),
      );
    } finally {
      await stopWeekly(ctx);
      globalThis.fetch = originalFetch;
      setMappingFile("");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Steam weekly prompt", () => {
  it("loads a plugin-local prompt with hot reload semantics", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-steam-prompt-"));
    const file = path.join(dir, "weekly-roast.md");
    try {
      fs.writeFileSync(file, "first", "utf-8");
      expect(loadWeeklyRoastPrompt(file)).toBe("first");

      fs.writeFileSync(file, "updated", "utf-8");
      expect(loadWeeklyRoastPrompt(file)).toBe("updated");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Steam weekly roast delivery", () => {
  it("sends the leaderboard before generating and sending 3 to 5 short comments", async () => {
    const events: string[] = [];
    const send = vi.fn(async (message: string) => { events.push(`send:${message}`); });
    const generate = vi.fn(async () => {
      events.push("generate");
      return "1. 第一刀\n- 第二刀\n第三刀\n第四刀\n第五刀\n第六刀";
    });

    await expect(deliverWeeklyReport("周榜", [{ appId: 1, name: "A", minutes: 1, playerQq: 1, playerName: "甲" }], send, generate)).resolves.toBe(5);

    expect(events).toEqual([
      "send:周榜",
      "generate",
      "send:第一刀",
      "send:第二刀",
      "send:第三刀",
      "send:第四刀",
      "send:第五刀",
    ]);
  });

  it("keeps the leaderboard when AI generation fails", async () => {
    const send = vi.fn(async () => {});

    await expect(deliverWeeklyReport(
      "周榜",
      [{ appId: 1, name: "A", minutes: 1, playerQq: 1, playerName: "甲" }],
      send,
      async () => { throw new Error("AI unavailable"); },
    )).resolves.toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("周榜");
  });

  it("does not call AI for an empty ranking or send malformed AI output", async () => {
    const send = vi.fn(async () => {});
    const generate = vi.fn(async () => "只有一句");

    await expect(deliverWeeklyReport("无人游玩", [], send, generate)).resolves.toBe(0);
    expect(generate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(parseRoastLines("一句\n两句")).toEqual([]);
  });

  it("returns the number of comments sent before a later send failure", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 4) throw new Error("send failed");
    });

    await expect(deliverWeeklyReport(
      "周榜",
      [{ appId: 1, name: "A", minutes: 1, playerQq: 1, playerName: "甲" }],
      send,
      async () => "第一句\n第二句\n第三句\n第四句",
    )).resolves.toBe(2);
  });
});
