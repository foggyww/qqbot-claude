import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  calculateWeeklyRanking,
  assignDuplicateSteamIds,
  deliverWeeklyReport,
  formatDuration,
  loadWeeklyRoastPrompt,
  loadWeeklyState,
  parseOwnedGames,
  parseRoastLines,
  saveWeeklyState,
  type SteamAccountSnapshots,
  type WeeklyParticipant,
} from "../plugins/steam/weekly.js";

const participants: WeeklyParticipant[] = [
  { qq: 1, displayName: "甲", steamIds: ["steam-a", "steam-b"] },
  { qq: 2, displayName: "乙", steamIds: ["steam-c"] },
];

describe("Steam weekly ranking", () => {
  it("calculates minute deltas and merges multiple accounts for one QQ user", () => {
    const baseline: SteamAccountSnapshots = {
      "steam-a": { "10": { name: "Game A", minutes: 100 } },
      "steam-b": { "10": { name: "Game A", minutes: 20 } },
      "steam-c": { "20": { name: "Game B", minutes: 50 } },
    };
    const current: SteamAccountSnapshots = {
      "steam-a": { "10": { name: "Game A", minutes: 145 } },
      "steam-b": { "10": { name: "Game A", minutes: 35 } },
      "steam-c": { "20": { name: "Game B", minutes: 80 } },
    };

    expect(calculateWeeklyRanking(participants, baseline, current)).toEqual([
      { appId: 10, name: "Game A", minutes: 60, players: ["甲"] },
      { appId: 20, name: "Game B", minutes: 30, players: ["乙"] },
    ]);
  });

  it("does not count lifetime minutes for accounts without a baseline", () => {
    const current: SteamAccountSnapshots = {
      "steam-a": { "10": { name: "Game A", minutes: 1000 } },
    };

    expect(calculateWeeklyRanking(participants, {}, current)).toEqual([]);
  });

  it("counts a newly purchased game from zero when the account has a baseline", () => {
    const baseline: SteamAccountSnapshots = { "steam-a": {} };
    const current: SteamAccountSnapshots = {
      "steam-a": { "10": { name: "New Game", minutes: 35 } },
    };

    expect(calculateWeeklyRanking(participants, baseline, current)).toEqual([
      { appId: 10, name: "New Game", minutes: 35, players: ["甲"] },
    ]);
  });

  it("assigns a Steam ID bound to multiple QQ users once, deterministically", () => {
    expect(assignDuplicateSteamIds([
      { qq: 20, displayName: "乙", steamIds: ["shared", "own-b"] },
      { qq: 10, displayName: "甲", steamIds: ["shared", "own-a"] },
    ])).toEqual([
      { qq: 20, displayName: "乙", steamIds: ["own-b"] },
      { qq: 10, displayName: "甲", steamIds: ["shared", "own-a"] },
    ]);
  });

  it("clamps decreasing totals and sorts ties deterministically", () => {
    const baseline: SteamAccountSnapshots = {
      "steam-a": {
        "20": { name: "Zulu", minutes: 100 },
        "10": { name: "Alpha", minutes: 100 },
        "30": { name: "Reset", minutes: 100 },
      },
    };
    const current: SteamAccountSnapshots = {
      "steam-a": {
        "20": { name: "Zulu", minutes: 110 },
        "10": { name: "Alpha", minutes: 110 },
        "30": { name: "Reset", minutes: 1 },
      },
    };

    expect(calculateWeeklyRanking(participants, baseline, current).map((row) => row.appId)).toEqual([10, 20]);
  });

  it("formats Steam minute precision for display", () => {
    expect(formatDuration(25)).toBe("25分钟");
    expect(formatDuration(125)).toBe("2小时5分钟");
    expect(formatDuration(120)).toBe("2小时");
  });

  it("rejects malformed owned-games responses instead of clearing a baseline", () => {
    expect(parseOwnedGames({ response: {} })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: 0 } })).toEqual({});
    expect(parseOwnedGames({ response: { game_count: 1, games: [] } })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: 1, games: [{ appid: 10 }] } })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: null } })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: "0" } })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: 1, games: [{ appid: true, playtime_forever: 1 }] } })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: 1, games: [{ appid: 10, playtime_forever: null }] } })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: 1, games: [{ appid: 10, playtime_forever: "25" }] } })).toBeNull();
    expect(parseOwnedGames({ response: { game_count: 1, games: [{ appid: 10, playtime_forever: 2.5 }] } })).toBeNull();
    expect(parseOwnedGames({
      response: { game_count: 1, games: [{ appid: 10, name: "Game", playtime_forever: 25 }] },
    })).toEqual({ "10": { name: "Game", minutes: 25 } });
  });
});

describe("Steam weekly state", () => {
  it("writes atomically and refuses to replace a damaged state file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-steam-weekly-"));
    const file = path.join(dir, "state.json");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    try {
      const state = { groups: {} };
      saveWeeklyState(state, file);
      expect(loadWeeklyState(file, logger)).toEqual(state);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      fs.writeFileSync(file, "{", "utf-8");
      expect(loadWeeklyState(file, logger)).toBeNull();
      expect(fs.readFileSync(file, "utf-8")).toBe("{");
      expect(logger.error).toHaveBeenCalled();
    } finally {
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

    await deliverWeeklyReport("周榜", [{ appId: 1, name: "A", minutes: 1, players: ["甲"] }], send, generate);

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
      [{ appId: 1, name: "A", minutes: 1, players: ["甲"] }],
      send,
      async () => { throw new Error("AI unavailable"); },
    )).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("周榜");
  });

  it("does not call AI for an empty ranking or send malformed AI output", async () => {
    const send = vi.fn(async () => {});
    const generate = vi.fn(async () => "只有一句");

    await deliverWeeklyReport("无人游玩", [], send, generate);
    expect(generate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(parseRoastLines("一句\n两句")).toEqual([]);
  });
});
