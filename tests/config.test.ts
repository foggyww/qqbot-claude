import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/core/config.js";

let tempRoot = "";
let originalCwd = "";
let originalToken: string | undefined;
let originalRunUser: string | undefined;
let originalRunUseSudo: string | undefined;

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
  originalRunUser = process.env.RUN_USER;
  originalRunUseSudo = process.env.RUN_USE_SUDO;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.RUN_USER;
  delete process.env.RUN_USE_SUDO;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-config-"));
  process.chdir(tempRoot);
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  process.chdir(originalCwd);
  if (originalToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
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
});
