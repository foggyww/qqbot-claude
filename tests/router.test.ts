import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig, Command, SessionStore } from "../src/core/types.js";
import type { RawMessageEvent } from "../src/core/context.js";

let mockedConfig: BotConfig;
let tempRoot = "";

vi.mock("../src/core/config.js", () => ({
  getConfig: () => mockedConfig,
}));

const router = await import("../src/core/router.js");

function baseConfig(): BotConfig {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-router-"));
  return {
    qq: { account: 1000, nickname: "bot" },
    onebot: { wsUrl: "ws://127.0.0.1:3000" },
    paths: {
      sessionsDir: path.join(tempRoot, "sessions"),
      projectsDir: path.join(tempRoot, "projects"),
      workspaceDir: path.join(tempRoot, "workspace"),
      projectDir: tempRoot,
      rootProjectsDir: path.join(tempRoot, "root-projects"),
    },
    env: {},
    run: { user: "tester", useSudo: false },
    models: { default: "flash", flash: "flash" },
    efforts: { default: "high" },
    settings: { timeout: 1, noPermissionReply: "无权限" },
    roles: { 1: 1, 2: 2, 3: 3 },
    groupWhitelist: [10],
    tools: [],
    prompt: { masterQq: 0 },
    steamWatcher: { intervalMinutes: 5, weeklyReportCron: "0 12 * * 0" },
  };
}

function event(rawMessage: string, userId = 1): RawMessageEvent {
  return {
    message_type: "private",
    user_id: userId,
    self_id: 1000,
    sender: { user_id: userId, nickname: `u${userId}` },
    raw_message: rawMessage,
    message_id: 1,
    message: rawMessage,
  };
}

function groupEvent(rawMessage: string, groupId = 10, userId = 1): RawMessageEvent {
  return {
    ...event(rawMessage, userId),
    message_type: "group",
    group_id: groupId,
  };
}

function command(name: string, prefix: string, handler = vi.fn(async () => "ok")): Command {
  return { name, description: name, prefix, minLevel: 1, handler };
}

function store(): SessionStore {
  return {
    loadModel: vi.fn(),
    saveModel: vi.fn(),
    loadEffort: vi.fn(),
    saveEffort: vi.fn(),
    isRootMode: vi.fn(() => false),
    setRootMode: vi.fn(),
    setChatMode: vi.fn(),
    getSessionId: vi.fn(() => null),
  };
}

beforeEach(() => {
  mockedConfig = baseConfig();
  fs.mkdirSync(mockedConfig.paths.sessionsDir, { recursive: true });
  router.setSessionStore(store(), "测试机器人");
});

afterEach(() => {
  for (const prefix of ["/a", "/abcd", "/secure", "/root-only", "/retry", "/timeout"]) {
    router.unregisterCommand(prefix);
  }
  router.unregisterDefaultCommand();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("router command resolution", () => {
  it("matches the longest prefix", () => {
    router.registerCommand(command("short", "/a"));
    router.registerCommand(command("long", "/abcd"));

    const resolved = router.resolveCommand("/abcd hello");
    expect(resolved.command?.name).toBe("long");
    expect(resolved.remaining).toBe("hello");
  });

  it("falls back to default command", () => {
    const defaultCommand: Command = { name: "default", description: "default", isDefault: true, minLevel: 1, handler: async () => "ok" };
    router.registerCommand(defaultCommand);

    expect(router.resolveCommand("hello").command?.name).toBe("default");
  });
});

describe("router dispatch", () => {
  it("rejects private messages from visitors", async () => {
    expect(await router.dispatchMessage(event("hello", 999))).toBe("无权限");
  });

  it("rejects commands when role level is too low", async () => {
    router.registerCommand({ ...command("secure", "/secure"), minLevel: 2 });

    const reply = await router.dispatchMessage(event("/secure x", 1));
    expect(reply).toContain("权限不足");
  });

  it("ignores non-whitelisted groups and messages without mention", async () => {
    router.registerCommand(command("a", "/a"));

    expect(await router.dispatchMessage(groupEvent("[CQ:at,qq=1000] /a", 11))).toBeNull();
    expect(await router.dispatchMessage(groupEvent("/a", 10))).toBeNull();
  });

  it("checks requireRoot before executing", async () => {
    router.registerCommand({ ...command("root", "/root-only"), requireRoot: true });

    expect(await router.dispatchMessage(event("/root-only", 3))).toBe("/root-only 仅在 /root 模式下可用");
  });

  it("does not repeat side effects when default commands output non-ok text", async () => {
    const handler = vi.fn(async () => "unexpected stdout");
    router.registerCommand({ name: "retry", description: "retry", isDefault: true, minLevel: 1, handler });

    const reply = await router.dispatchMessage(event("hello", 1));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(reply).toBe("【stdout】unexpected stdout");
  });

  it("serializes stateful commands and creates session directories before handlers", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async (msg: string, dir: string) => {
      expect(fs.existsSync(dir)).toBe(true);
      order.push(`start:${msg}`);
      if (msg === "first") await gate;
      order.push(`end:${msg}`);
      return "ok";
    });
    router.registerCommand(command("a", "/a", handler));
    const first = router.dispatchMessage(event("/a first"));
    const second = router.dispatchMessage(event("/a second"));
    await vi.waitFor(() => expect(order).toEqual(["start:first"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("returns a friendly timeout message", async () => {
    const handler = vi.fn(async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    });
    router.registerCommand({ ...command("timeout", "/timeout", handler), minLevel: 1 });

    await expect(router.dispatchMessage(event("/timeout", 1))).resolves.toBe("处理超时，操作可能已完成，请先查询账本确认，避免重复记账");
  });
});
