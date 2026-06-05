# qqbot — Claude Code 开发参考

## 项目定位

TypeScript Node.js QQ 机器人。把 Claude Code CLI 作为 AI 引擎接到 QQ（私聊+群聊）。AI 通过 MCP 工具发送 QQ 消息、查询 Steam、上网搜索。

## 技术栈

- Runtime: Node.js >= 22 (ESM, `"type": "module"`)
- Language: TypeScript 5.x (strict)
- QQ 协议: OneBot v11 over WebSocket (NapCat/Lagrange)
- AI 引擎: Claude Code CLI (`claude -p ...`)
- 配置: `.qqbotrc.toml` (cosmiconfig)
- 包管理: npm

## 目录结构

```
src/
├── core/
│   ├── types.ts           # 所有公共接口定义
│   ├── config.ts          # 配置加载 (.qqbotrc.toml → BotConfig)
│   ├── bot.ts             # Bot 主类 + SessionStore
│   ├── context.ts         # 会话上下文构建 (sessionKey, buildCtx, stripContent)
│   ├── permission.ts      # 角色系统 (getLevel, isGroupWhitelisted)
│   ├── router.ts          # 消息分发 + 命令注册 + 群聊缓存
│   └── user_mapping.ts    # 通用用户信息映射 (任何插件可读写)
├── adapter/
│   └── onebot.ts          # OneBot v11 WebSocket 适配器
├── ai/
│   └── claude-code.ts     # Claude Code CLI 调用
├── mcp/
│   ├── host.ts            # 项目内 MCP Host，随 Bot 生命周期启停
│   └── qq-server.ts       # QQ 操作 MCP server (10个工具，复用 QQAdapter)
├── plugin/
│   ├── index.ts           # PluginSystem (加载/注册/MCP聚合)
│   └── builtin/           # 按用途分组的内置命令集
└── scheduler/
    └── index.ts           # 任务调度 (cron + interval)
plugins/
└── steam/                 # Steam 插件 (自包含)
    ├── index.ts
    ├── commands.ts
    ├── mcp-server.ts
    └── watcher.ts
runtime/                   # 运行时数据 (gitignored，本机/Docker 默认共用配置路径)
prompts/                   # 提示词 .md 文件
```

## 核心设计

### 消息处理流程

```
QQ消息 → OneBotAdapter → Bot.handleIncomingMessage()
  → PluginSystem.onMessage() (所有插件被动监听)
  → router.dispatchMessage()
    → 私聊: handlePrivateMessage() → 权限检查 → resolveCommand → executeCommand
    → 群聊: handleGroupMessage() → 缓存消息 → 白名单检查 → @检测 → 空@等待 → executeCommand
```

### 指令系统

指令注册在 `router.ts` 中，通过 `registerCommand()` 注册。

```ts
interface Command {
  name: string;
  description: string;
  prefix?: string;        // undefined = 默认对话
  isDefault?: boolean;
  isSetter?: boolean;      // 可无参执行 (如 /root)
  minLevel: 0|1|2|3;
  requireRoot?: boolean;
  handler: (msg, sessionDir, ctx) => Promise<string | void>;
}
```

### 角色系统

| Level | 标签 | 权限范围 |
|-------|------|---------|
| 0 | 访客 | 私聊拒绝，群聊需要白名单 |
| 1 | 用户 | 默认对话、/help |
| 2 | 可信用户 | + /edit /model /think /schedule /steam /reset |
| 3 | 管理员 | + /root /auth /add-command |

角色配置在 `.qqbotrc.toml` 的 `[roles]` 段，`/auth` 命令可动态增删 (默认写入 `runtime/data/auth.json`)。

### 会话管理

- session_key = `private_{QQ}` 或 `group_{群号}`
- session_dir = `{sessionsDir}/{session_key}/`
- 状态文件: `.model`, `.effort`, `.run_as_root`
- Claude Code 会话存在 `{projectsDir}/{encoded_path}/*.jsonl`
- Root 模式使用当前运行用户的 Claude Code projects 目录
- Docker 和本机默认共用同一份 `.qqbotrc.toml`；默认路径统一为 `./runtime/...`

### AI 后端

- Chat 模式: 默认当前进程用户直接运行 `claude ...`；`[run].use_sudo=true` 仅作为旧式宿主机降权运行兼容项
- 运行用户默认策略: 推荐 Docker 部署，容器内以 `node` 用户直接运行；本机备用部署则以启动进程的当前用户直接运行
- Root 模式: `claude -p "msg" ...` (仍为当前进程用户直接执行)
- 环境变量从 `config.env` 和 `process.env` 合并

### MCP 架构

```
Claude Code → McpHost (HTTP JSON-RPC, 随 Bot 启停)
  ├── /mcp/qqbot
  │   ├── send_message, get_group_list, get_group_members
  │   ├── get_group_msg_history, get_private_msg_history
  │   ├── get_user_info, delete_message, sleep
  │   ├── get_user_mapping (通用用户信息)
  │   └── get_my_info
  └── /mcp/qqbot-steam
      └── steam_get_* (9个工具)
```

内置 QQ MCP server 由 `createQqMcpServer(adapter)` 创建，直接复用当前 `QQAdapter`。它不启动独立 QQ 连接，也不请求旧 HTTP API。

默认 MCP Host 地址：

```text
http://127.0.0.1:8765/mcp/<server>
```

可用环境变量覆盖：`QQBOT_MCP_HOST`、`QQBOT_MCP_PORT`。

### 架构约束

```text
QQ 操作统一入口：OneBotAdapter / QQAdapter
MCP 生命周期：跟随 Bot.start() / Bot.stop()
旧项目依赖：禁止调用旧 Python HTTP API 或旧项目数据目录
Prompt：运行时从 prompts/*.md 读取，支持热更新
配置：.qqbotrc.toml 本地私有，不提交
```

完整架构设计见 `docs/architecture.md`。

### 插件接口

```ts
interface Plugin {
  name: string;
  version: string;
  description?: string;
  commands?: Command[];
  mcpServers?: McpServer[];     // 插件自带 MCP
  ccPluginDir?: string;         // Claude Code 原生插件目录
  onLoad?(ctx: BotContext): Promise<void>;
  onUnload?(ctx: BotContext): Promise<void>;
  onMessage?(msgCtx: MessageContext): Promise<void>;
}
```

插件可自带 MCP 服务器、命令、生命周期钩子。Steam 插件是标准实现参考。

### 配置加载

1. `cosmiconfig("qqbot")` 搜索 `.qqbotrc.toml`
2. 合并 `runtime/data/auth.json` 动态授权
3. 环境变量覆盖 (`ANTHROPIC_AUTH_TOKEN`、`ONEBOT_WS_URL`、`RUN_*`)
4. `npm run setup` / `npm run setup:docker` 可生成 Docker 部署配置；`npm run setup:local` 可生成本机部署配置；`npm run verify` 可检查本机运行环境

## 开发命令

```bash
npm run dev        # tsx watch 模式
npm run setup      # Docker 推荐安装入口 (同 setup:docker)
npm run setup:docker # 生成 .qqbotrc.toml + .env，不要求宿主机 Node 以外依赖
npm run setup:local  # 本机备用部署安装向导
npm run verify     # 检查 Node/Claude/OneBot/运行用户环境
npm run build      # tsc 编译
npm run typecheck  # 仅类型检查
npm run lint       # eslint
npm test           # vitest
```

## 修改后必须做的事

1. `npm run typecheck` 确零错误
2. 如果是提示词: 改 `prompts/*.md`，即时生效
3. 如果是配置: 改 `.qqbotrc.toml`，需要重启
4. 如果是插件: 放到 `plugins/` 目录，重启自动加载
