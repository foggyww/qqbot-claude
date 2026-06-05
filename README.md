# qqbot-claude

一个基于 **Claude Code + DeepSeek + NapCat/OneBot v11** 的 TypeScript QQ 机器人。

它把 QQ 消息接入 Claude Code CLI，并通过项目内置的 MCP 工具让模型能够主动发送 QQ 消息、读取上下文、调用插件能力。默认示例使用 DeepSeek 的 Anthropic-compatible API 作为模型后端，也可以按 Claude Code 支持的方式切换到其他兼容服务。

## 特性

- **Claude Code 驱动对话**：私聊或群聊 @ bot 后，由 Claude Code 生成回复。
- **DeepSeek API 支持**：通过 Anthropic-compatible 环境变量接入 DeepSeek 模型。
- **NapCat / OneBot v11 接入**：支持 Docker Compose 内置 NapCat，也可连接已有 OneBot WebSocket。
- **内置 MCP Host**：QQ 操作和插件工具通过 MCP 暴露给 Claude Code，无需依赖外部旧服务。
- **权限与群白名单**：支持角色等级、群聊白名单、管理员命令。
- **多会话隔离**：私聊和群聊分别维护 Claude Code 会话状态。
- **插件系统**：插件可提供命令、MCP tools、Claude Code 原生插件目录和生命周期钩子。
- **Steam 插件示例**：包含 Steam 查询与状态监控插件，可作为自定义插件参考。

## 架构概览

```text
QQ / 群聊
  ↓
NapCat / OneBot v11 WebSocket
  ↓
OneBotAdapter
  ↓
Bot Core
  ├─ Router / Command System
  ├─ Permission / Session Store
  ├─ Plugin System
  ├─ Scheduler
  ├─ Claude Code Backend
  └─ MCP Host
      ├─ qqbot          # QQ send_message / history / member tools
      └─ qqbot-steam    # Steam plugin tools
```

MCP Host 默认监听本机：

```text
GET  http://127.0.0.1:8765/health
POST http://127.0.0.1:8765/mcp/qqbot
POST http://127.0.0.1:8765/mcp/qqbot-steam
```

更多设计细节见 [`docs/architecture.md`](docs/architecture.md)。

## 推荐部署：Docker Compose

最简单的服务器部署方式是 Docker Compose。宿主机只需要安装 Docker，不需要安装 Node.js、Claude Code CLI 或 NapCat。

```bash
git clone <repo-url>
cd qqbot-claude
./scripts/setup-docker.sh
```

`setup-docker.sh` 不依赖 Node.js，会交互生成：

- `.qqbotrc.toml`：qqbot 唯一配置来源，包含 Bot QQ、API Key、管理员、群白名单、模型、路径、Steam Web API Key 等。
- `.env`：只给 Docker Compose / NapCat 使用，例如 `BOT_QQ`、`NAPCAT_MODE`、可选 `ONEBOT_WS_URL`。

高级用户也可以跳过脚本，手动复制并编辑：

```bash
cp .qqbotrc.toml.example .qqbotrc.toml
cp .env.example .env
```

> Docker 和本机运行都读取同一份 `.qqbotrc.toml`。Docker Compose 只会用环境变量临时覆盖 `ONEBOT_WS_URL`，以适配容器网络；这不会生成第二份 qqbot 配置。

> Steam 插件/MCP 也从 `.qqbotrc.toml` 的 `[env].STEAM_WEB_API_KEY` 读取配置；不要依赖宿主机 `~/.bashrc`，Docker 容器不会读取它。

启动：

```bash
docker compose up -d --build
```

这会同时启动 `qqbot` 和内置 `napcat` 两个容器。

如果你已经有自己的 NapCat / OneBot 服务，不想启动本项目内置 NapCat：

1. 在 `.env` 中覆盖 Docker 的 OneBot 地址，例如：

```env
ONEBOT_WS_URL=ws://你的OneBot服务器:3000
```

2. 只启动 `qqbot` 服务：

```bash
docker compose up -d --build qqbot
```

然后打开 NapCat WebUI：

```text
http://服务器IP:6099
```

在 NapCat 中扫码登录 Bot QQ。默认 Compose 会让 NapCat 使用内置 `ws` 模板启用 OneBot v11 WebSocket，端口为 `3001`。Docker 内部 bot 默认连接：

```text
ws://napcat:3001
```

查看日志：

```bash
docker compose logs -f qqbot
docker compose logs -f napcat
```

停止：

```bash
docker compose down
```

升级：

```bash
git pull
docker compose up -d --build
```

Docker 运行时，qqbot 仍然读取项目根目录同一份 `.qqbotrc.toml`；配置文件会只读挂载到容器内 `/app/.qqbotrc.toml`。Compose 只会按需覆盖 `ONEBOT_WS_URL`，用于解决本机地址和 Docker service DNS 的差异。

> `QQBOT_GENERATE_CONFIG=1` 是容器入口保留的兼容模式，只适合非标准 `docker run` 场景。推荐部署请使用 `./scripts/setup-docker.sh` 或手动维护项目根目录 `.qqbotrc.toml`；Docker Compose 默认把该文件只读挂载进容器，不推荐在容器内生成第二份配置。

qqbot 自己的运行数据在容器项目目录内闭环，统一位于：

- `qqbot_runtime` → `/app/runtime`

其中：

- `/app/runtime/data`：qqbot 数据
- `/app/runtime/sessions`：qqbot 会话状态
- `/app/runtime/workspace`：AI 工作区
- `/app/runtime/.claude/projects`：Claude Code JSONL/session 记录

NapCat 是 OneBot 依赖服务，不属于本项目运行数据，使用自己的 Docker volumes：

- `napcat_config` → `/app/napcat/config`
- `napcat_qq_config` → `/app/.config/QQ`

查看 volumes：

```bash
docker volume ls | grep qqbot
```

> `docker compose down` 不会删除这些数据；只有执行 `docker compose down -v` 才会删除 volumes。

> 如果你已经有自己的 NapCat / OneBot 服务，可以在 `.env` 中设置 `ONEBOT_WS_URL`。

## 本机部署前置条件

- Node.js >= 22
- npm
- Claude Code CLI，可在命令行执行 `claude`
- 一个可用的 Anthropic-compatible 模型服务，例如 DeepSeek
- NapCat 或其他 OneBot v11 WebSocket 实现

> 本项目只实现 QQ bot 框架和 OneBot 客户端，不包含 QQ 协议端本身。请自行准备并配置 NapCat/Lagrange 等 OneBot 服务。

## 本机部署

### 1. 安装依赖

```bash
git clone <repo-url>
cd qqbot-claude
npm install
```

### 2. 快速配置

```bash
npm run setup:local
```

安装向导会询问 2 个必填项、3 个可选项：

```text
Bot QQ 号:                                      # 必填
DeepSeek / Anthropic API Key:                   # 必填
OneBot WebSocket 地址 (ws://127.0.0.1:3000):     # 可选，回车用默认
管理员 QQ 号（可选，回车跳过）:                    # 可选
群白名单，多个群号用英文逗号分隔（可选）:             # 可选
Steam Web API Key（可选，回车跳过）:                   # 可选，Steam 插件/MCP 使用
```

如果 `.qqbotrc.toml` 已存在，`npm run setup:local` 默认不会覆盖。需要重新生成时使用：

```bash
npm run setup:local -- --force
```

`.qqbotrc.toml` 包含账号、群号和密钥，已被 `.gitignore` 忽略，不要提交。本机和 Docker 共用这一份配置；运行数据默认统一放在 `./runtime/`，该目录也已被忽略。

也可以手动复制模板配置：

```bash
cp .qqbotrc.toml.example .qqbotrc.toml
```

### 3. 配置 NapCat / OneBot

确保 OneBot WebSocket 服务可被本项目连接。默认地址是：

```text
ws://127.0.0.1:3000
```

如果需要修改地址，可以在 `.qqbotrc.toml` 中配置：

```toml
[onebot]
ws_url = "ws://127.0.0.1:3000"
```

也可以用环境变量临时覆盖：

```bash
ONEBOT_WS_URL=ws://127.0.0.1:3001 npm run dev
```

验证本机环境和 OneBot 连接：

```bash
npm run verify
```

> `npm run setup` 是 Docker 推荐安装入口，等价于 `npm run setup:docker`。本机部署请使用 `npm run setup:local`。

### 4. 构建并运行

开发模式：

```bash
npm run dev
```

构建后运行：

```bash
npm run build
node dist/src/cli.js
```

启动后，在白名单群里 @bot，或向 bot 私聊发送 `/help` 查看命令。

## 配置说明

配置文件使用 TOML，模板见 [`.qqbotrc.toml.example`](.qqbotrc.toml.example)。

常用段落：

```toml
[qq]
account = 0
platform = "napcat"
nickname = ""

[onebot]
ws_url = "ws://127.0.0.1:3000"

[env]
ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
ANTHROPIC_AUTH_TOKEN = "sk-xxxxxxxx"
ANTHROPIC_MODEL = "deepseek-v4-pro"

[roles]
"123456789" = 3

[group_whitelist]
ids = []

[prompt]
master_qq = 0
```

运行用户通常不需要配置：默认始终用当前进程用户直接运行 Claude Code。推荐 Docker 部署时，该用户就是容器内的 `node` 用户；本机备用部署时，就是启动 `npm run dev` / `node dist/src/cli.js` 的用户。只有需要兼容旧式宿主机降权运行时，才在 `.qqbotrc.toml` 中增加 `[run]` 段并显式设置 `use_sudo = true`。

角色等级：

| Level | 说明 |
| --- | --- |
| 0 | 访客 |
| 1 | 普通用户 |
| 2 | 可信用户 |
| 3 | 管理员 |

## 常用命令

```bash
npm run dev        # 开发模式运行
npm run build      # 构建到 dist/
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint
npm test           # Vitest 测试
```

bot 内命令可通过 `/help` 查看。内置命令按插件集组织，包括会话、模型、权限、定时任务、root 模式等能力。

## 插件开发

插件放在 `plugins/` 目录，可提供：

- bot 命令
- MCP server/tools
- Claude Code 原生插件目录
- `onLoad` / `onUnload` / `onMessage` 生命周期钩子

最小示例：

```ts
import type { Plugin } from "qqbot-claude";

export default class MyPlugin implements Plugin {
  name = "my-plugin";
  version = "1.0.0";
  commands = [
    {
      name: "hello",
      description: "say hello",
      prefix: "/hello",
      minLevel: 1,
      handler: async (_msg, _sessionDir, ctx) => `你好，${ctx.senderNick ?? "朋友"}`,
    },
  ];
}
```

更多说明见：

- [`docs/plugin-guide.md`](docs/plugin-guide.md)
- [`docs/plugin-system.md`](docs/plugin-system.md)

## 目录结构

```text
src/
├── adapter/      # OneBot v11 adapter
├── ai/           # Claude Code CLI backend
├── core/         # Bot core, config, router, permission, session
├── mcp/          # Built-in MCP Host and QQ MCP server
├── plugin/       # Plugin system and built-in command sets
├── scheduler/    # Scheduled tasks
└── prompt.ts     # Runtime prompt loader

plugins/
└── steam/        # Steam plugin example

prompts/          # System prompts, hot-reloaded at runtime
docs/             # Architecture and plugin docs
```

## 安全说明

- 不要提交 `.qqbotrc.toml`、`.env`、`runtime/`、`data.migrated-*/`、`dist/`、日志文件。
- 不要把真实 QQ 号、群号、API key 写入文档或示例配置。
- Claude Code 具备工具调用和文件操作能力，请谨慎配置 `allowedTools` 和运行用户权限。
- 群聊建议开启白名单，只让 bot 在指定群中响应。

## License

MIT
