#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

const configPath = path.join(process.cwd(), ".qqbotrc.toml");

function log(message) {
  console.log(`[docker-entrypoint] ${message}`);
}

function fail(message) {
  console.error(`[docker-entrypoint] ERROR ${message}`);
  process.exit(1);
}

function env(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function requireNumberEnv(name) {
  const value = env(name);
  if (!/^\d+$/.test(value)) fail(`${name} 必须填写为数字`);
  return Number(value);
}

function requireEnv(name) {
  const value = env(name);
  if (!value) fail(`${name} 不能为空。请先创建 .qqbotrc.toml，或设置 QQBOT_GENERATE_CONFIG=1 并提供兼容环境变量。`);
  return value;
}

function ensureDirs() {
  for (const dir of [
    "runtime/data",
    "runtime/sessions",
    "runtime/workspace",
    "runtime/.claude/projects",
  ]) {
    fs.mkdirSync(path.join(process.cwd(), dir), { recursive: true });
  }
}

function generateConfig() {
  const botQq = requireNumberEnv("BOT_QQ");
  const adminQqRaw = env("ADMIN_QQ");
  const adminQq = adminQqRaw ? Number(adminQqRaw) : 0;
  if (adminQqRaw && !/^\d+$/.test(adminQqRaw)) fail("ADMIN_QQ 必须填写为数字，或留空");

  const authToken = requireEnv("ANTHROPIC_AUTH_TOKEN");
  const baseUrl = env("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic");
  const model = env("ANTHROPIC_MODEL", "deepseek-v4-pro");
  const flashModel = env("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
  const wsUrl = env("ONEBOT_WS_URL", "ws://napcat:3000");
  const adminRole = adminQq ? `"${adminQq}" = 3` : "# \"123456789\" = 3";

  const content = `# QQBot Docker 配置文件
# 由容器启动时根据兼容环境变量自动生成。推荐改为直接维护项目根目录 .qqbotrc.toml。

[qq]
account = ${botQq}
platform = "napcat"
nickname = ""

[onebot]
ws_url = ${tomlString(wsUrl)}

[run]
user = "node"
use_sudo = false

[paths]
sessions_dir = "./runtime/sessions"
projects_dir = "./runtime/.claude/projects"
workspace_dir = "./runtime/workspace"
project_dir = "."
root_projects_dir = "./runtime/.claude/projects"

[env]
DEEPSEEK_API_KEY = ${tomlString(authToken)}
ANTHROPIC_BASE_URL = ${tomlString(baseUrl)}
ANTHROPIC_AUTH_TOKEN = ${tomlString(authToken)}
ANTHROPIC_MODEL = ${tomlString(model)}
ANTHROPIC_DEFAULT_OPUS_MODEL = ${tomlString(env("ANTHROPIC_DEFAULT_OPUS_MODEL", model))}
ANTHROPIC_DEFAULT_SONNET_MODEL = ${tomlString(env("ANTHROPIC_DEFAULT_SONNET_MODEL", model))}
ANTHROPIC_DEFAULT_HAIKU_MODEL = ${tomlString(flashModel)}
CLAUDE_CODE_SUBAGENT_MODEL = ${tomlString(env("CLAUDE_CODE_SUBAGENT_MODEL", model))}
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1"
CLAUDE_CODE_EFFORT_LEVEL = "high"

[models]
default = "flash"
flash = ${tomlString(flashModel)}
pro = ${tomlString(model)}

[efforts]
default = "high"

[settings]
timeout = 180
no_permission_reply = "无权限"

[roles]
${adminRole}

[group_whitelist]
ids = []

[prompt]
master_qq = ${adminQq || 0}

[tools]
allowed = [
  "Read",
  "Bash",
  "Edit",
  "Write",
  "WebSearch",
  "WebFetch",
  "mcp__qqbot__send_message",
  "mcp__qqbot__sleep",
  "mcp__qqbot__get_user_mapping",
  "mcp__qqbot__get_group_msg_history",
  "mcp__qqbot__get_group_members",
  "mcp__qqbot__get_group_list",
  "mcp__qqbot__get_private_msg_history",
  "mcp__qqbot__get_user_info",
  "mcp__qqbot__delete_message",
  "mcp__qqbot__get_my_info",
  "mcp__qqbot-steam__steam_get_player_summaries",
  "mcp__qqbot-steam__steam_get_friend_list",
  "mcp__qqbot-steam__steam_get_owned_games",
  "mcp__qqbot-steam__steam_get_recently_played_games",
  "mcp__qqbot-steam__steam_get_user_stats_for_game",
  "mcp__qqbot-steam__steam_get_player_achievements",
  "mcp__qqbot-steam__steam_get_global_achievement_percentages",
  "mcp__qqbot-steam__steam_search_games",
  "mcp__qqbot-steam__steam_resolve_vanity_url",
]

[steam_watcher]
interval_minutes = 5
`;

  fs.writeFileSync(configPath, content, { encoding: "utf-8", mode: 0o600 });
  log("已根据兼容环境变量生成 .qqbotrc.toml");
}

function runCommand(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

ensureDirs();
if (fs.existsSync(configPath) && fs.statSync(configPath).isFile() && env("QQBOT_GENERATE_CONFIG") !== "1") {
  log("检测到 .qqbotrc.toml，使用项目配置文件");
} else if (env("QQBOT_GENERATE_CONFIG") === "1") {
  generateConfig();
} else {
  fail("未找到 .qqbotrc.toml。请先运行 `npm run setup`，或复制 .qqbotrc.toml.example 为 .qqbotrc.toml 后再启动 Docker。");
}

const [, , command = "node", ...args] = process.argv;
runCommand(command, args);
