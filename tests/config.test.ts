import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../src/core/config.js";

let tempRoot = "";
let originalCwd = "";
let originalToken: string | undefined;
let originalOnebotWsUrl: string | undefined;
let originalRunUser: string | undefined;
let originalRunUseSudo: string | undefined;
let warnSpy: ReturnType<typeof vi.spyOn>;

function writeConfig(content: string): string {
  const file = path.join(tempRoot, ".qqbotrc.toml");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function minimalConfig(extra = ""): string {
  return `
[qq]
account = 123
platform = "napcat"
nickname = "配置昵称"

[onebot]
ws_url = "ws://127.0.0.1:3001"

[paths]
sessions_dir = "${path.join(tempRoot, "sessions").replace(/\\/g, "\\\\")}"
projects_dir = "${path.join(tempRoot, "projects").replace(/\\/g, "\\\\")}"
workspace_dir = "${path.join(tempRoot, "workspace").replace(/\\/g, "\\\\")}"
project_dir = "${tempRoot.replace(/\\/g, "\\\\")}"
root_projects_dir = "${path.join(tempRoot, "root-projects").replace(/\\/g, "\\\\")}"

[env]
ANTHROPIC_AUTH_TOKEN = "from-config"

[models]
default = "flash"
flash = "flash-model"

[efforts]
default = "high"

[settings]
timeout = 42
no_permission_reply = "无权"

[run]
user = "configured-user"
use_sudo = false

[roles]
"1" = 1

[group_whitelist]
ids = [10]

[prompt]
master_qq = 999

[steam_watcher]
interval_minutes = 7
${extra}
`;
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
  originalOnebotWsUrl = process.env.ONEBOT_WS_URL;
  originalRunUser = process.env.RUN_USER;
  originalRunUseSudo = process.env.RUN_USE_SUDO;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ONEBOT_WS_URL;
  delete process.env.RUN_USER;
  delete process.env.RUN_USE_SUDO;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-config-"));
  process.chdir(tempRoot);
  resetConfigCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  resetConfigCache();
  process.chdir(originalCwd);
  if (originalToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
  if (originalOnebotWsUrl === undefined) delete process.env.ONEBOT_WS_URL;
  else process.env.ONEBOT_WS_URL = originalOnebotWsUrl;
  if (originalRunUser === undefined) delete process.env.RUN_USER;
  else process.env.RUN_USER = originalRunUser;
  if (originalRunUseSudo === undefined) delete process.env.RUN_USE_SUDO;
  else process.env.RUN_USE_SUDO = originalRunUseSudo;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads qq nickname, run config, paths and settings", async () => {
    const config = await loadConfig(writeConfig(minimalConfig()));

    expect(config.qq).toEqual({ account: 123, platform: "napcat", nickname: "配置昵称" });
    expect(config.onebot.wsUrl).toBe("ws://127.0.0.1:3001");
    expect(config.run).toEqual({ user: "configured-user", useSudo: false });
    expect(config.settings.timeout).toBe(42);
    expect(config.groupWhitelist).toEqual([10]);
    expect(config.steamWatcher.intervalMinutes).toBe(7);
  });

  it("lets environment variables override selected fields", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "from-env";
    process.env.RUN_USER = "env-user";
    process.env.RUN_USE_SUDO = "true";

    const config = await loadConfig(writeConfig(minimalConfig()));

    expect(config.env.ANTHROPIC_AUTH_TOKEN).toBe("from-env");
    expect(config.run.user).toBe("env-user");
    expect(config.run.useSudo).toBe(true);
  });

  it("merges runtime/data/auth.json roles over configured roles", async () => {
    fs.mkdirSync(path.join(tempRoot, "runtime", "data"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "runtime", "data", "auth.json"), JSON.stringify({ "1": 3, "2": 2 }));

    const config = await loadConfig(writeConfig(minimalConfig()));

    expect(config.roles[1]).toBe(3);
    expect(config.roles[2]).toBe(2);
  });

  it("throws when no config file is found", async () => {
    await expect(loadConfig()).rejects.toThrow("未找到配置文件");
  });

  it("rejects zero qq account", async () => {
    const content = minimalConfig().replace("account = 123", "account = 0");

    await expect(loadConfig(writeConfig(content))).rejects.toThrow("[qq].account 必须为正整数");
  });

  it("rejects invalid OneBot WebSocket URL", async () => {
    const content = minimalConfig().replace('ws_url = "ws://127.0.0.1:3001"', 'ws_url = "http://127.0.0.1:3001"');

    await expect(loadConfig(writeConfig(content))).rejects.toThrow("[onebot].ws_url 必须以 ws:// 或 wss:// 开头");
  });

  it("allows ONEBOT_WS_URL to override an invalid config URL", async () => {
    process.env.ONEBOT_WS_URL = "wss://onebot.example/ws";
    const content = minimalConfig().replace('ws_url = "ws://127.0.0.1:3001"', 'ws_url = "http://127.0.0.1:3001"');

    const config = await loadConfig(writeConfig(content));

    expect(config.onebot.wsUrl).toBe("wss://onebot.example/ws");
  });

  it("warns on unknown config sections", async () => {
    await loadConfig(writeConfig(minimalConfig(`
[unknown_section]
value = true
`)));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("未知配置段 [unknown_section]"));
  });

  it("warns on placeholder AI keys", async () => {
    const content = minimalConfig().replace('ANTHROPIC_AUTH_TOKEN = "from-config"', 'ANTHROPIC_AUTH_TOKEN = "placeholder-key"');

    await loadConfig(writeConfig(content));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("AI API Key 看起来仍是占位符"));
  });

  it("normalizes invalid positive settings with warnings", async () => {
    const content = minimalConfig()
      .replace("timeout = 42", "timeout = -1")
      .replace("interval_minutes = 7", "interval_minutes = -1");

    const config = await loadConfig(writeConfig(content));

    expect(config.settings.timeout).toBe(180);
    expect(config.steamWatcher.intervalMinutes).toBe(5);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[settings].timeout 必须为正数"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[steam_watcher].interval_minutes 不能为负数"));
  });

  it("warns and skips invalid role levels", async () => {
    const content = minimalConfig().replace('"1" = 1', '"1" = 99');

    const config = await loadConfig(writeConfig(content));

    expect(config.roles[1]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[roles].1 的等级 99 无效"));
  });
});
