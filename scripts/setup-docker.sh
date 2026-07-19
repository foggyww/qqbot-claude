#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE=".qqbotrc.toml"
ENV_FILE=".env"
DEFAULT_ONEBOT_WS_URL="ws://127.0.0.1:3000"

log() { printf '[setup:docker] %s\n' "$*"; }
fail() { printf '[setup:docker] ERROR %s\n' "$*" >&2; exit 1; }

toml_string() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1" 2>/dev/null || {
    local s=${1//\\/\\\\}
    s=${s//\"/\\\"}
    printf '"%s"' "$s"
  }
}

ask() {
  local prompt=$1
  local default=${2:-}
  local value
  if [ -n "$default" ]; then
    read -r -p "$prompt ($default): " value
    printf '%s' "${value:-$default}"
  else
    read -r -p "$prompt: " value
    printf '%s' "$value"
  fi
}

write_config() {
  local qq_account=$1
  local api_key=$2
  local admin_qq=$3
  local group_ids=$4
  local onebot_ws_url=$5
  local steam_api_key=$6

  local admin_role='# "123456789" = 3'
  local master_qq=0
  if [ -n "$admin_qq" ]; then
    admin_role="\"$admin_qq\" = 3"
    master_qq=$admin_qq
  fi

  cat > "$CONFIG_FILE" <<EOF
# QQBot 配置文件
# 由 ./scripts/setup-docker.sh 生成；高级用户可直接编辑本文件。

[qq]
account = $qq_account
platform = "napcat"
nickname = ""

[onebot]
# 本机运行会使用这个地址；Docker Compose 默认会用 ONEBOT_WS_URL 覆盖为 ws://napcat:3001。
ws_url = $(toml_string "$onebot_ws_url")

[paths]
sessions_dir = "./runtime/sessions"
projects_dir = "./runtime/.claude/projects"
workspace_dir = "./runtime/workspace"
project_dir = "."
root_projects_dir = "./runtime/.claude/projects"

[env]
DEEPSEEK_API_KEY = $(toml_string "$api_key")
ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
ANTHROPIC_AUTH_TOKEN = $(toml_string "$api_key")
ANTHROPIC_MODEL = "deepseek-v4-pro"
ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro"
ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro"
ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-pro"
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1"
CLAUDE_CODE_EFFORT_LEVEL = "high"
STEAM_WEB_API_KEY = $(toml_string "$steam_api_key")

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
$admin_role

[group_whitelist]
ids = [$group_ids]

[prompt]
master_qq = $master_qq

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
  "mcp__qqbot-steam__steam_publish_group_recent_ranking",
]

[steam_watcher]
interval_minutes = 5
EOF
  chmod 600 "$CONFIG_FILE" || true
}

write_env() {
  local qq_account=$1
  cat > "$ENV_FILE" <<EOF
# Docker Compose / NapCat 编排变量。qqbot 自己的配置在 .qqbotrc.toml。
BOT_QQ=$qq_account
NAPCAT_MODE=ws

# 高级用户：如果不用 compose 内置 NapCat，可取消注释并改成外部 OneBot 地址。
# ONEBOT_WS_URL=ws://你的OneBot服务器:3000
EOF
  chmod 600 "$ENV_FILE" || true
}

read_config_account() {
  [ -f "$CONFIG_FILE" ] || return 1
  local section="" line account=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*\[([^]]+)\][[:space:]]*$ ]]; then
      section="${BASH_REMATCH[1]}"
      continue
    fi
    if [ "$section" = "qq" ] && [[ "$line" =~ ^[[:space:]]*account[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
      account="${BASH_REMATCH[1]}"
      break
    fi
  done < "$CONFIG_FILE"
  [ -n "$account" ] || return 1
  printf '%s' "$account"
}

ensure_runtime_dirs() {
  mkdir -p runtime/data runtime/sessions runtime/workspace runtime/.claude/projects
}

main() {
  local force=0 start=0
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      --start) start=1 ;;
      *) fail "未知参数：$arg" ;;
    esac
  done

  if ! command -v docker >/dev/null 2>&1; then
    fail "未找到 docker。请先安装 Docker。"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    fail "未找到 Docker Compose 插件。请先安装 docker compose。"
  fi

  if [ -e "$CONFIG_FILE" ] && [ "$force" -ne 1 ]; then
    log "已存在 $CONFIG_FILE，跳过生成。需要覆盖请加 --force。"
  else
    printf '\nQQBot Docker 一键配置\n--------------------\n'
    local qq_account api_key admin_qq group_ids onebot_ws_url steam_api_key
    qq_account=$(ask "Bot QQ 号")
    [[ "$qq_account" =~ ^[0-9]+$ ]] || fail "Bot QQ 号必须是数字"
    api_key=$(ask "DeepSeek / Anthropic API Key")
    [ -n "$api_key" ] || fail "API Key 不能为空"
    admin_qq=$(ask "管理员 QQ 号（可选，回车跳过）")
    [[ -z "$admin_qq" || "$admin_qq" =~ ^[0-9]+$ ]] || fail "管理员 QQ 号必须是数字，或留空"
    group_ids=$(ask "群白名单，多个群号用英文逗号分隔（可选）")
    if [ -n "$group_ids" ] && ! [[ "$group_ids" =~ ^[0-9]+([[:space:]]*,[[:space:]]*[0-9]+)*$ ]]; then
      fail "群白名单格式错误，应为：123,456"
    fi
    onebot_ws_url=$(ask "本机运行用 OneBot WebSocket 地址" "$DEFAULT_ONEBOT_WS_URL")
    [[ "$onebot_ws_url" =~ ^wss?:// ]] || fail "OneBot 地址必须以 ws:// 或 wss:// 开头"
    steam_api_key=$(ask "Steam Web API Key（可选，回车跳过）")
    write_config "$qq_account" "$api_key" "$admin_qq" "$group_ids" "$onebot_ws_url" "$steam_api_key"
    log "已生成 $CONFIG_FILE"

    if [ -e "$ENV_FILE" ] && [ "$force" -ne 1 ]; then
      log "已存在 $ENV_FILE，跳过生成。高级用户可自行编辑。"
    else
      write_env "$qq_account"
      log "已生成 $ENV_FILE"
    fi
  fi

  if [ ! -e "$ENV_FILE" ]; then
    local env_qq_account
    env_qq_account=$(read_config_account || true)
    if [ -z "$env_qq_account" ]; then
      env_qq_account=$(ask "用于 NapCat 的 Bot QQ 号")
      [[ "$env_qq_account" =~ ^[0-9]+$ ]] || fail "Bot QQ 号必须是数字"
    fi
    write_env "$env_qq_account"
    log "已根据 $CONFIG_FILE 生成 $ENV_FILE"
  fi

  ensure_runtime_dirs
  log "已准备 runtime 目录"

  if [ "$start" -eq 1 ]; then
    log "正在启动 Docker Compose..."
    docker compose up -d --build
    log "已启动。查看日志：docker compose logs -f qqbot napcat"
  else
    log "下一步运行：docker compose up -d --build"
    log "然后打开 NapCat WebUI： http://服务器IP:6099"
  fi
}

main "$@"
