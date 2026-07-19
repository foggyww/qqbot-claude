import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/core/types.js";

let mockedConfig: BotConfig;

vi.mock("../src/core/config.js", () => ({
  getConfig: () => mockedConfig,
}));

const { getLevel, isGroupWhitelisted, LEVEL_LABELS } = await import("../src/core/permission.js");

function baseConfig(): BotConfig {
  return {
    qq: { account: 1, nickname: "bot" },
    onebot: { wsUrl: "ws://127.0.0.1:3000" },
    paths: { sessionsDir: "/tmp/s", projectsDir: "/tmp/p", workspaceDir: "/tmp/w", projectDir: "/tmp/pr", rootProjectsDir: "/tmp/r" },
    env: {},
    run: { user: "tester", useSudo: false },
    models: { default: "flash", flash: "flash" },
    efforts: { default: "high" },
    settings: { timeout: 1, noPermissionReply: "无权限" },
    roles: { 123: 3, 456: 1 },
    groupWhitelist: [789],
    tools: [],
    prompt: { masterQq: 0 },
    steamWatcher: { intervalMinutes: 5, weeklyReportCron: "0 12 * * 0" },
  };
}

beforeEach(() => {
  mockedConfig = baseConfig();
});

describe("permission", () => {
  it("returns configured roles and defaults unknown users to level 0", () => {
    expect(getLevel(123)).toBe(3);
    expect(getLevel(456)).toBe(1);
    expect(getLevel(999)).toBe(0);
  });

  it("checks group whitelist", () => {
    expect(isGroupWhitelisted(789)).toBe(true);
    expect(isGroupWhitelisted(790)).toBe(false);
  });

  it("exposes labels for all role levels", () => {
    expect(LEVEL_LABELS).toEqual({ 0: "访客", 1: "用户", 2: "可信用户", 3: "管理员" });
  });
});
