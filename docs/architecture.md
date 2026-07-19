# qqbot-ts 架构设计

本文档描述 qqbot-ts 当前的运行时架构、模块边界、核心数据流和扩展点。项目目标是：用 TypeScript 独立实现 QQ 机器人能力，不依赖旧 Python 项目或旧 HTTP API。

## 1. 总体架构

```text
NapCat / Lagrange
  │ OneBot v11 WebSocket
  ▼
OneBotAdapter
  │ 统一 QQAdapter 接口：收消息、发消息、查群/成员/历史、撤回等
  ▼
Bot
  ├─ PluginSystem        加载内置插件和外部插件
  ├─ Router              权限、白名单、@ 检测、命令分发、默认对话
  ├─ SessionStore        会话状态：模型、思考强度、root/chat 模式、Claude session id
  ├─ Scheduler           cron / interval 定时任务
  ├─ Claude Code Backend 调用 claude CLI
  └─ McpHost             项目内 MCP Host，随 Bot 启停
       ├─ qqbot          内置 QQ MCP server，复用当前 QQAdapter
       └─ qqbot-steam    Steam 插件 MCP server
```

核心原则：

- **单一 QQ 通道**：所有 QQ 操作通过 `QQAdapter` / `OneBotAdapter` 走 OneBot WebSocket。
- **不依赖旧项目**：不调用旧 Python 项目的 HTTP API，也不依赖旧项目数据目录。
- **插件化扩展**：命令、MCP 工具、被动消息监听、生命周期钩子都通过插件系统接入。
- **生命周期集中**：`Bot` 负责配置、插件、Adapter、MCP Host 的启动与停止顺序。

## 2. 启动与生命周期

入口：

- 开发：`npm run dev` → `tsx src/core/index.ts`
- 构建：`npm run build` → `dist/src/core/index.js` / `dist/src/cli.js`
- CLI：`qqbot` → `dist/src/cli.js`
- Docker：`docker compose up -d --build` → `qqbot` 服务运行 `node dist/src/cli.js --config .qqbotrc.toml`，`napcat` 服务提供 OneBot WebSocket。

路径闭环原则：Docker 和本机运行共用项目根目录同一份 `.qqbotrc.toml`。默认路径统一使用 `./runtime/...`；本机运行时落在宿主项目目录，Docker 运行时落在容器项目目录 `/app/runtime`，并由 Docker volume `qqbot_runtime` 持久化。Docker Compose 只会用环境变量覆盖 OneBot URL 这类网络拓扑差异，不生成第二份 qqbot 配置。NapCat 只作为 OneBot 依赖服务，其配置/登录态由 NapCat 自己的 volume 管理，不混入 qqbot runtime。

生命周期：

```text
loadConfig(.qqbotrc.toml) → new OneBotAdapter(config.onebot.wsUrl) → new Bot(adapter)
  │
  ├─ init(configPath?)
  │   ├─ loadConfig(.qqbotrc.toml)（入口已预加载，init 会复用缓存）
  │   ├─ 合并 runtime/data/auth.json 动态授权
  │   ├─ 将 config.env 注入主进程 process.env，供插件使用
  │   ├─ 创建 sessionsDir
  │   ├─ 注入 SessionStore 到 Router
  │   ├─ 加载内置插件与 plugins/ 外部插件
  │   ├─ 注册内置 QQ MCP server
  │   └─ 将 Claude Code 原生插件目录注入 AI backend
  │
  ├─ start()
  │   ├─ adapter.onMessage(Bot.handleIncomingMessage)
  │   ├─ adapter.start()       连接配置中的 OneBot WebSocket
  │   └─ McpHost.start()       启动项目内 MCP HTTP JSON-RPC Host
  │
  └─ stop()
      ├─ Scheduler.stop()
      ├─ PluginSystem.unregisterAll()
      ├─ McpHost.stop()
      └─ adapter.stop()
```

`runForever()` 注册 `SIGINT` / `SIGTERM`，收到信号后调用 `stop()` 并退出。

## 3. 消息处理链路

```text
QQ 消息
  ▼
OneBotAdapter.handleMessage()
  ├─ API 响应：按 echo 唤醒 pending call
  ├─ 心跳：忽略
  └─ message event：parseOneBotEvent → buildCtx
       ▼
Bot.handleIncomingMessage()
  ├─ pluginSystem.onMessage(ctx)       插件被动监听
  └─ router.dispatchMessage(rawEvent)
       ├─ buildCtx / sessionKey
       ├─ 创建 sessionDir
       ├─ 私聊：权限检查 → resolveCommand → executeCommand
       └─ 群聊：缓存消息 → 白名单 → @ 检测 → 空 @ 等待 → executeCommand
```

群聊内容清理规则：

- 删除 `@bot` 自己的 CQ 码
- 删除非 `at` 类型 CQ 码
- **保留 @其他人** 的 CQ 码，避免丢失用户意图

## 4. 模块边界

### 4.1 core

`src/core/` 是框架核心：

- `types.ts`：公共接口定义，包含 `BotConfig`、`QQAdapter`、`Command`、`Plugin`、`McpServer` 等。
- `config.ts`：加载 `.qqbotrc.toml`，并合并 `runtime/data/auth.json` 动态授权。
- `bot.ts`：生命周期编排者。
- `context.ts`：原始 OneBot event → `MessageContext`。
- `router.ts`：命令注册、命令解析、权限和群聊路由。
- `permission.ts`：角色等级与群白名单。
- `user_mapping.ts`：插件共享的 QQ 用户映射数据。

### 4.2 adapter

`src/adapter/onebot.ts` 实现 `QQAdapter`：

- 连接 `.qqbotrc.toml` 的 `[onebot].ws_url`，默认 `ws://127.0.0.1:3000`。
- 可用环境变量 `ONEBOT_WS_URL` 临时覆盖配置。
- 通过 OneBot reverse WebSocket 发送 `{ action, params, echo }`。
- 使用 echo 匹配 API 响应。
- 支持超时、断线 pending call 拒绝、指数退避重连。

当前暴露能力：

- `sendPrivateMsg`
- `sendGroupMsg`
- `getGroupList`
- `getGroupMembers`
- `getGroupMsgHistory`
- `getPrivateMsgHistory`
- `getStrangerInfo`
- `deleteMsg`
- `callApi`

### 4.3 plugin

`PluginSystem` 负责：

- 加载内置插件集：`src/plugin/builtin/*.plugin.ts`
- 加载本地插件：`plugins/*/index.ts` 或插件入口文件
- 注册插件命令到 Router
- 收集插件 MCP server
- 收集 Claude Code 原生插件目录 `ccPluginDir`
- 调用 `onLoad` / `onUnload` / `onMessage`

插件可提供：

- `commands`
- `mcpServers`
- `ccPluginDir`
- 生命周期钩子
- 被动消息监听

插件系统完整工作原理见 [`plugin-system.md`](plugin-system.md)。

### 4.4 ai

`src/ai/claude-code.ts` 封装 Claude Code CLI：

- Chat 模式：默认用当前进程用户直接运行 `claude ...`；`[run].use_sudo=true` 仅作为旧式宿主机降权运行的高级兼容项。
  - Docker 推荐部署中，当前用户为容器内 `node` 用户，不需要宿主机安装或启用 Claude Code。
  - 本机备用部署中，当前用户为启动进程的用户。
- Root 模式：当前用户直接运行 `claude ...`
- 合并 `process.env` 与 `config.env`
- 设置 `--permission-mode acceptEdits`
- 传入 `--allowedTools`
- 根据 session id 使用 `--resume`
- 将插件系统收集的 `ccPluginDir` 传给 `--plugin-dir`

### 4.5 scheduler

`src/scheduler/index.ts` 提供 cron / interval 调度。定时任务触发时调用 Claude backend，并附加系统提示：

```text
触发定时任务。用 send_message 回复。完成后只输出 ok。
```

### 4.6 mcp

MCP 由两层组成：

1. `McpServer`：工具集合抽象，插件或内置模块提供。
2. `McpHost`：项目内 HTTP JSON-RPC host，统一暴露所有 MCP server。

默认 endpoint：

```text
GET  /health
POST /mcp/qqbot
POST /mcp/qqbot-steam
```

默认监听：

```text
QQBOT_MCP_HOST=127.0.0.1  # 未配置认证时仅允许 loopback
QQBOT_MCP_PORT=8765
```

内置 `qqbot` MCP server 不自己连接 QQ，也不请求旧 HTTP API，而是复用当前 `QQAdapter`。

## 5. MCP 设计

### 5.1 内置 QQ MCP server

文件：`src/mcp/qq-server.ts`

工具：

- `send_message`
- `get_group_list`
- `get_group_members`
- `get_group_msg_history`
- `get_private_msg_history`
- `get_user_info`
- `delete_message`
- `get_user_mapping`
- `get_my_info`
- `sleep`

所有 QQ API 类工具都调用 `QQAdapter`；本地数据类工具读取 `runtime/data/user_mapping.json`。

### 5.2 插件 MCP server

插件通过 `mcpServers` 暴露 MCP 工具。Steam 插件示例：

```text
plugins/steam/mcp-server.ts → createSteamMcpServer()
```

`Bot.start()` 时会把 `PluginSystem.getAllMcpServers()` 交给 `McpHost`。

## 6. 配置与数据

配置文件：`.qqbotrc.toml`，不提交。模板：`.qqbotrc.toml.example`。
Docker 和本机运行都读取同一份 `.qqbotrc.toml`；Docker Compose 只额外使用 `.env` 给 NapCat/Compose 提供 `BOT_QQ`、`ONEBOT_WS_URL` 等编排变量。推荐 Docker 用户运行 `./scripts/setup-docker.sh` 或 `npm run setup:docker` 生成 `.qqbotrc.toml` + `.env`；本机备用部署通过 `npm run setup:local` 生成最小配置，`npm run verify` 检查 Node.js、Claude CLI、OneBot WS 和运行用户环境。高级用户可跳过脚本，直接编辑 `.qqbotrc.toml` 和 `.env`。

配置加载顺序：

1. `loadConfig(configPath?)`
2. `cosmiconfig("qqbot")` 搜索 `.qqbotrc.toml`
3. 解析 TOML 为 `BotConfig`
4. 合并 `runtime/data/auth.json`
5. 环境变量覆盖部分敏感项和运行参数，例如 `ANTHROPIC_AUTH_TOKEN`、`ONEBOT_WS_URL`、`RUN_USER`、`RUN_UID`、`RUN_GID`、`RUN_USE_SUDO`

运行时数据：

- `runtime/data/auth.json`：动态授权
- `runtime/data/user_mapping.json`：QQ → Steam/GitHub 等第三方账号映射
- `runtime/data/steam_state.json`：Steam watcher 状态
- `runtime/data/steam_subscriptions.json`：Steam 群订阅状态
- `runtime/data/steam_weekly_state.json`：按群隔离的 Steam 周榜累计时长快照和发送周期

## 7. 权限与会话

角色等级：

| Level | 含义 | 权限 |
|---|---|---|
| 0 | 访客 | 默认无私聊权限；群聊需白名单 |
| 1 | 用户 | 默认对话、基础命令 |
| 2 | 可信用户 | 模型、思考、编辑、定时任务、Steam、reset |
| 3 | 管理员 | root、auth、add-command |

会话：

- 私聊：`private_{QQ}`
- 群聊：`group_{群号}`
- 会话目录：`{sessionsDir}/{sessionKey}`
- 状态文件：`.model`、`.effort`、`.run_as_root`
- Claude session id：从 `{projectsDir}/{encoded_session_dir}/*.jsonl` 推断

## 8. 关键设计约束

- 不调用 `127.0.0.1:8080` 旧 HTTP API。
- 不依赖旧 Python 项目目录。
- MCP server 跟随 TS 项目启动停止。
- QQ 操作必须通过 `QQAdapter`，避免多套 QQ 通道。
- Prompt 文件每次读取磁盘，支持热更新。
- `.qqbotrc.toml`、`runtime/`、`data/`、`dist/`、`node_modules/` 不提交。

## 9. 当前已知改进点

- 核心测试覆盖仍偏少，目前主要覆盖 `stripContent`。
- session path 编码逻辑后续可抽成独立 `session` 工具模块。
- `user_mapping` 类型可进一步收敛，尤其是 `steam_ids: string[]`。
- 如果 Claude Code 运行环境只支持 stdio MCP，需要另加 HTTP → stdio bridge；项目内部 MCP Host 已经是自包含的。
