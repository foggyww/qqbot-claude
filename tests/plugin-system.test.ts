import { describe, expect, it, vi } from "vitest";
import { PluginSystem } from "../src/plugin/index.js";
import { getDefaultCommand, getRegisteredCommands } from "../src/core/router.js";
import type { BotContext, Plugin } from "../src/core/types.js";

function mockCtx(): BotContext {
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
      env: {},
      run: { user: "tester", useSudo: false },
      models: { default: "flash", flash: "flash" },
      efforts: { default: "high" },
      settings: { timeout: 1, noPermissionReply: "无权限" },
      roles: {},
      groupWhitelist: [],
      tools: [],
      prompt: { masterQq: 0 },
      steamWatcher: { intervalMinutes: 5, weeklyReportCron: "0 12 * * 0" },
    },
    sessionDir: "/tmp/sessions",
    adapter: {
      start: vi.fn(),
      stop: vi.fn(),
      onMessage: vi.fn(),
      sendPrivateMsg: vi.fn(),
      sendGroupMsg: vi.fn(),
      getGroupList: vi.fn(),
      getGroupMembers: vi.fn(),
      getGroupMsgHistory: vi.fn(),
      getPrivateMsgHistory: vi.fn(),
      getStrangerInfo: vi.fn(),
      deleteMsg: vi.fn(),
    },
    sessionStore: {
      loadModel: vi.fn(),
      saveModel: vi.fn(),
      loadEffort: vi.fn(),
      saveEffort: vi.fn(),
      isRootMode: vi.fn(),
      setRootMode: vi.fn(),
      setChatMode: vi.fn(),
      getSessionId: vi.fn(),
    },
    sendMessage: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    scheduler: { addJob: vi.fn(), removeJob: vi.fn(), getJob: vi.fn() },
  };
}

describe("PluginSystem", () => {
  it("registers and unregisters default commands", async () => {
    const plugin: Plugin = {
      name: "test-default",
      version: "1.0.0",
      commands: [
        {
          name: "default-test-command",
          description: "default",
          isDefault: true,
          minLevel: 1,
          handler: async () => "ok",
        },
      ],
    };

    const system = new PluginSystem(mockCtx());
    await system.register(plugin);
    expect(getDefaultCommand()?.name).toBe("default-test-command");

    await system.unregister("test-default");
    expect(getDefaultCommand()).toBeNull();
  });

  it("aggregates plugin MCP servers and unregisters prefixed commands", async () => {
    const plugin: Plugin = {
      name: "test-mcp",
      version: "1.0.0",
      commands: [
        {
          name: "test-command",
          description: "test",
          prefix: "/test-plugin-system",
          minLevel: 1,
          handler: async () => "ok",
        },
      ],
      mcpServers: [
        {
          name: "test-server",
          version: "1.0.0",
          tools: [],
          handleToolCall: async () => "ok",
        },
      ],
    };

    const system = new PluginSystem(mockCtx());
    await system.register(plugin);
    expect(getRegisteredCommands().get("/test-plugin-system")?.name).toBe("test-command");
    expect(system.getAllMcpServers().map((item) => item.server.name)).toEqual(["test-server"]);

    await system.unregister("test-mcp");
    expect(getRegisteredCommands().has("/test-plugin-system")).toBe(false);
  });

  it("unloads every plugin in reverse order and continues after an unload error", async () => {
    const ctx = mockCtx();
    const calls: string[] = [];
    const system = new PluginSystem(ctx);
    await system.register({ name: "first", version: "1", onUnload: async () => { calls.push("first"); } });
    await system.register({
      name: "second",
      version: "1",
      onUnload: async () => {
        calls.push("second");
        throw new Error("broken cleanup");
      },
    });

    await system.unregisterAll();

    expect(calls).toEqual(["second", "first"]);
    expect(system.list()).toEqual([]);
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining("broken cleanup"));
  });
});
