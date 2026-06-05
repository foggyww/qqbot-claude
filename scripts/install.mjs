#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_ONEBOT_WS_URL = "ws://127.0.0.1:3000";
const CONFIG_FILE = path.join(process.cwd(), ".qqbotrc.toml");

const argv = process.argv.slice(2);
const args = new Set(argv);
const checkOnly = args.has("--check") || args.has("--non-interactive");
const force = args.has("--force");

function log(msg) { console.log(`[setup] ${msg}`); }
function fail(msg) { console.error(`[setup] ERROR ${msg}`); process.exitCode = 1; }

function commandExists(cmd) {
  try {
    execFileSync("/usr/bin/env", ["bash", "-lc", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function parseMajor(version) {
  return Number(version.replace(/^v/, "").split(".")[0] ?? 0);
}

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

async function checkWebSocket(url) {
  if (typeof WebSocket === "undefined") {
    throw new Error("当前 Node.js 没有全局 WebSocket，请使用 Node.js 22+");
  }
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`连接超时: ${url}`));
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve(undefined);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`连接失败: ${url}`));
    };
  });
}

function ensureDir(dir, owner) {
  fs.mkdirSync(dir, { recursive: true });
  if (owner && isRoot()) {
    try { execFileSync("chown", ["-R", owner, dir], { stdio: "ignore" }); } catch {}
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function generateConfig({ qqAccount, apiKey, onebotWsUrl, adminQq, groupWhitelist, steamApiKey }) {
  const adminRole = adminQq ? `"${Number(adminQq)}" = 3` : "# \"123456789\" = 3";
  const masterQq = adminQq ? Number(adminQq) : 0;
  const groups = groupWhitelist ? groupWhitelist.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)).join(", ") : "";
  return `# QQBot 配置文件
# 由 npm run setup:local 生成；需要高级配置时可参考 .qqbotrc.toml.example

[qq]
account = ${Number(qqAccount)}
platform = "napcat"
nickname = ""

[onebot]
ws_url = ${tomlString(onebotWsUrl)}

[paths]
sessions_dir = "./runtime/sessions"
projects_dir = "./runtime/.claude/projects"
workspace_dir = "./runtime/workspace"
project_dir = "."
root_projects_dir = "./runtime/.claude/projects"

[env]
DEEPSEEK_API_KEY = ${tomlString(apiKey)}
ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
ANTHROPIC_AUTH_TOKEN = ${tomlString(apiKey)}
ANTHROPIC_MODEL = "deepseek-v4-pro"
ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro"
ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro"
ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-pro"
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1"
CLAUDE_CODE_EFFORT_LEVEL = "high"
STEAM_WEB_API_KEY = ${tomlString(steamApiKey || "")}

[models]
default = "flash"
flash = "deepseek-v4-flash"
pro = "deepseek-v4-pro"

[efforts]
default = "high"

[settings]
timeout = 180
no_permission_reply = "无权限"

[roles]
${adminRole}

[group_whitelist]
ids = [${groups}]

[prompt]
master_qq = ${masterQq}

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
}

async function askSetupQuestions() {
  const rl = createInterface({ input, output });
  try {
    const qqAccount = (await rl.question("Bot QQ 号: ")).trim();
    if (!/^\d+$/.test(qqAccount)) throw new Error("Bot QQ 号必须是数字");

    const apiKey = (await rl.question("DeepSeek / Anthropic API Key: ")).trim();
    if (!apiKey) throw new Error("API Key 不能为空");

    const onebotWsUrlInput = (await rl.question(`OneBot WebSocket 地址 (${DEFAULT_ONEBOT_WS_URL}): `)).trim();
    const onebotWsUrl = onebotWsUrlInput || DEFAULT_ONEBOT_WS_URL;
    if (!/^wss?:\/\//.test(onebotWsUrl)) throw new Error("OneBot WebSocket 地址必须以 ws:// 或 wss:// 开头");

    const adminQq = (await rl.question("管理员 QQ 号（可选，回车跳过）: ")).trim();
    if (adminQq && !/^\d+$/.test(adminQq)) throw new Error("管理员 QQ 号必须是数字，或留空");

    const groupWhitelist = (await rl.question("群白名单，多个群号用英文逗号分隔（可选）: ")).trim();
    if (groupWhitelist && !/^\d+(\s*,\s*\d+)*$/.test(groupWhitelist)) {
      throw new Error("群白名单格式错误，应为：123,456");
    }

    const steamApiKey = (await rl.question("Steam Web API Key（可选，回车跳过）: ")).trim();

    return { qqAccount, apiKey, onebotWsUrl, adminQq, groupWhitelist, steamApiKey };
  } finally {
    rl.close();
  }
}

function readWsUrlFromConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return process.env.ONEBOT_WS_URL || DEFAULT_ONEBOT_WS_URL;
  const text = fs.readFileSync(CONFIG_FILE, "utf-8");
  const match = text.match(/^\s*ws_url\s*=\s*["']([^"']+)["']/m);
  return process.env.ONEBOT_WS_URL || match?.[1] || DEFAULT_ONEBOT_WS_URL;
}

async function createConfigIfNeeded() {
  if (checkOnly) return;
  if (fs.existsSync(CONFIG_FILE) && !force) {
    log("已存在 .qqbotrc.toml，跳过生成配置。需要覆盖请运行：npm run setup:local -- --force");
    return;
  }

  console.log("\nQQBot 本机一键配置（2 项必填，4 项可选）");
  console.log("--------------------------------");
  const answers = await askSetupQuestions();
  fs.writeFileSync(CONFIG_FILE, generateConfig(answers), { encoding: "utf-8", mode: 0o600 });
  log("已生成 .qqbotrc.toml");
}

async function checkPrerequisites(wsUrl) {
  const nodeMajor = parseMajor(process.version);
  if (nodeMajor < 22) fail(`Node.js 版本过低：${process.version}，需要 >= 22`);
  else log(`Node.js ${process.version} OK`);

  if (!commandExists("claude")) fail("未找到 Claude Code CLI：请先安装并确保 `claude` 在 PATH 中");
  else log(`Claude Code CLI OK (${run("claude", ["--version"]) || "version unknown"})`);

  try {
    await checkWebSocket(wsUrl);
    log(`OneBot WebSocket OK (${wsUrl})`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function prepareRunUser() {
  ensureDir(path.join(process.cwd(), "runtime", "data"));
  ensureDir(path.join(process.cwd(), "runtime", "sessions"));
  ensureDir(path.join(process.cwd(), "runtime", ".claude", "projects"));
  ensureDir(path.join(process.cwd(), "runtime", "workspace"));
  log(`将使用当前用户运行 Claude：${os.userInfo().username}`);
  if (isRoot()) {
    log("提示：检测到当前为 root。推荐使用 Docker 部署；本机 root 运行时 Claude Code 也会默认以当前 root 用户直接运行。");
  }
}

async function main() {
  log(checkOnly ? "开始验证本机运行环境" : "开始本机安装向导");
  await createConfigIfNeeded();
  const wsUrl = readWsUrlFromConfig();
  await checkPrerequisites(wsUrl);
  prepareRunUser();

  if (process.exitCode) process.exit(process.exitCode);
  log(checkOnly ? "验证完成" : "本机安装完成。下一步运行：npm run dev");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(process.exitCode || 1);
});
