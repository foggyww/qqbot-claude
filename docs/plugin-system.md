# 插件系统工作原理

本文档说明 qqbot-ts 插件系统的设计、加载规则、运行流程、MCP 集成、Claude Code 原生插件目录，以及开发外部插件时需要遵守的约束。

## 1. 插件系统定位

插件系统是 qqbot-ts 的主要扩展机制。一个插件可以同时提供：

- QQ 命令：例如 `/help`、`/steam`、`/model`
- MCP server：给 Claude Code 暴露工具
- Claude Code 原生插件目录：通过 `--plugin-dir` 传给 Claude Code
- 生命周期钩子：`onLoad` / `onUnload`
- 被动消息监听：`onMessage`

运行时位置：

```text
Bot.init()
  └─ PluginSystem.loadPlugins()
       ├─ 扫描并 import 插件模块
       ├─ 实例化插件类
       ├─ 注册 commands 到 Router
       ├─ 收集 mcpServers 给 McpHost
       ├─ 收集 ccPluginDir 给 Claude Code backend
       └─ 调用 plugin.onLoad(ctx)

Bot.start()
  ├─ OneBotAdapter.start()
  └─ McpHost.start(pluginSystem.getAllMcpServers())
```

## 2. 插件接口

源码定义：`src/core/types.ts`

```ts
interface Plugin {
  name: string;
  version: string;
  description?: string;
  commands?: Command[];
  mcpServers?: McpServer[];
  ccPluginDir?: string;
  onLoad?(ctx: BotContext): Promise<void>;
  onUnload?(ctx: BotContext): Promise<void>;
  onMessage?(msgCtx: MessageContext): Promise<void>;
}
```

约束：

- `name` 和 `version` 必填。
- `name` 必须全局唯一；重复名称会跳过后加载的插件。
- 当前插件类必须可以无参构造：`new PluginCtor()`。
- 支持导出名：`default`、`Plugin`、`plugin`，但导出值必须是构造函数。

推荐写法：

```ts
import type { Plugin } from "qqbot";

export default class MyPlugin implements Plugin {
  name = "my-plugin";
  version = "1.0.0";
  description = "示例插件";
}
```

## 3. 加载目录与文件命名规则

加载顺序：

| 顺序 | 目录 | 说明 |
|---|---|---|
| 1 | 内置插件目录 | `src/plugin/builtin/*.plugin.ts` 或构建后 `dist/src/plugin/builtin/*.plugin.js` |
| 2 | 本地插件目录 | 开发时 `plugins/`，构建后优先 `dist/plugins/` |
| 3 | 配置项目插件目录 | `{config.paths.projectDir}/plugins`，构建后优先 `{projectDir}/dist/plugins` |

内置命令实现文件和插件注册单元是分开的：

- `src/plugin/builtin/<command>.ts`：单个命令的 handler 和 `COMMANDS` 导出。
- `src/plugin/builtin/*.plugin.ts`：真正被 PluginSystem 加载的内置插件集，按用途聚合多个命令。

当前内置插件集：

| 插件集 | 命令 | 用途 |
|---|---|---|
| `builtin-core` | `/help`、默认对话、`/chat`、`/reset` | 核心交互与会话重置 |
| `builtin-session` | `/model`、`/think`、`/root` | 会话状态、模型、思考强度和 root 模式 |
| `builtin-workspace` | `/edit`、`/add-command` | 工作区编辑和命令扩展 |
| `builtin-operations` | `/schedule`、`/auth` | 定时任务与授权管理 |

这样可以保持命令实现文件足够小，同时避免“一个命令一个插件”的注册粒度。

外部插件目录的规则：

- 子目录插件包：`plugins/<name>/index.ts` 或 `index.js`
- 单文件插件：`index.*`、`*.plugin.*`、`*-plugin.*`、`*_plugin.*`
- 不符合规则的 helper 文件不会被单独加载。

## 4. dev 与 build 的差异

开发模式：

```bash
npm run dev
```

- 通过 `tsx src/core/index.ts` 运行。
- 可以直接加载 `.ts` 插件源码。
- `ccPluginDir` 指向源码目录，例如 `plugins/steam/claude-plugin`。

构建模式：

```bash
npm run build
node dist/src/cli.js
```

- `tsc` 编译 `src/**/*.ts` 和 `plugins/**/*.ts` 到 `dist/`。
- `scripts/copy-assets.mjs` 复制非 TS 资源，例如 `plugins/steam/claude-plugin`。
- 构建后插件优先从 `dist/plugins/` 加载，避免 Node 直接 import 源码 `.ts` 时遇到路径解析问题。
- `ccPluginDir` 指向构建后的目录，例如 `dist/plugins/steam/claude-plugin`。

## 5. 命令插件

```ts
interface Command {
  name: string;
  description: string;
  prefix?: string;
  isDefault?: boolean;
  isSetter?: boolean;
  minLevel: 0 | 1 | 2 | 3;
  requireRoot?: boolean;
  handler: (msg: string, sessionDir: string, ctx: MessageContext) => Promise<string | void>;
}
```

注册逻辑：

- 有 `prefix` 的命令注册到全局 `Map<prefix, Command>`。
- `isDefault: true` 的命令成为默认对话命令。
- prefix 重复会打印 warning，后注册命令覆盖先注册命令。
- 默认命令重复也会打印 warning，并以后注册命令为准。

匹配逻辑：

1. 所有 prefix 按长度降序排序。
2. 消息等于 `prefix` 时触发。
3. 消息以 `prefix + 空格` 开头时触发。
4. 都不匹配时，走默认命令。

## 6. 权限与群聊触发

权限检查在 Router 层完成：

- 私聊：`level === 0` 直接拒绝。
- 群聊：群必须在白名单内，且通常需要 @bot。
- 命令：`userLevel < command.minLevel` 时拒绝。
- `requireRoot` 命令必须在 root 模式会话中执行。

插件 handler 通常不需要重复做权限检查。

## 7. 生命周期钩子

| 钩子 | 入参 | 时机 | 典型用途 |
|---|---|---|---|
| `onLoad` | `BotContext` | 插件注册后 | 初始化资源、读取配置、启动 watcher |
| `onUnload` | `BotContext` | 插件卸载时 | 停止定时器、关闭连接 |
| `onMessage` | `MessageContext` | 每条消息进入 Router 前 | 日志、审计、被动监听 |

`onMessage` 异常会被捕获并记录，不会阻断其他插件或主路由。

## 8. BotContext 能力

```ts
interface BotContext {
  config: BotConfig;
  sessionDir: string;
  adapter: QQAdapter;
  sessionStore: SessionStore;
  sendMessage(type: "private" | "group", target: number, message: string): Promise<void>;
  logger: Logger;
  scheduler: SchedulerRef;
}
```

插件要操作 QQ，应使用 `ctx.adapter` 或 `ctx.sendMessage`。不要自己连接 NapCat，也不要调用旧 HTTP API。

## 9. MCP server 插件

插件可以提供 MCP server：

```ts
interface McpServer {
  name: string;
  version: string;
  tools: McpToolDefinition[];
  handleToolCall(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}
```

所有插件的 `mcpServers` 会被 `PluginSystem.getAllMcpServers()` 聚合，并由 `McpHost` 暴露：

```text
GET  /health
POST /mcp/<server-name>
```

默认地址：

```text
http://127.0.0.1:8765/mcp/<server-name>
```

工具白名单中使用 Claude Code 命名空间格式：

```text
mcp__<server-name>__<tool-name>
```

## 10. Claude Code 原生插件目录 ccPluginDir

`ccPluginDir` 不是 qqbot-ts 插件本身，而是 Claude Code 的原生插件目录。

例如 Steam 插件：

```text
plugins/steam/
├── index.ts                    qqbot-ts 插件入口
├── mcp-server.ts               qqbot-ts MCP server
├── prompts/                    Steam 插件私有 Prompt，运行时热读取
│   └── weekly-roast.md
└── claude-plugin/              Claude Code 原生插件目录
    ├── .claude-plugin/plugin.json
    ├── hooks/hooks.json
    └── skills/steam.md
```

在 `plugins/steam/index.ts` 中：

```ts
ccPluginDir = "claude-plugin";
```

PluginSystem 会把它解析成绝对路径，保存到 `ccPluginDirs`。之后 Claude backend 每次调用 `claude` 时会追加：

```text
--plugin-dir /absolute/path/to/claude-plugin
```

这意味着：

- 它不是全局安装 Claude Code 插件。
- 它是**每次 Claude Code 会话临时加载**的插件目录。
- 当前环境的 `claude --help` 明确支持 `--plugin-dir <path>`。
- 构建后必须保证该目录被复制到 `dist/plugins/.../claude-plugin`。

Steam 的 `skills/steam.md` 会让 Claude Code 知道 Steam MCP 工具的使用方式；`hooks/hooks.json` 当前为空。

## 11. Steam 插件流程

启动时：

1. PluginSystem 加载 `SteamPlugin`。
2. 注册 `/steam` 命令。
3. 聚合 `qqbot-steam` MCP server。
4. 解析并收集 `claude-plugin` 目录。
5. `onLoad()` 初始化 Steam watcher。

调用 Claude 时：

1. Claude backend 传入 `--plugin-dir .../claude-plugin`。
2. Claude Code 读取 Steam skill。
3. Claude 使用 `mcp__qqbot-steam__*` 工具。

## 12. 常见坑

- 插件类必须可无参构造；配置放到 `onLoad(ctx)` 中读取。
- 生产运行时应使用 `dist/plugins`，不要直接加载源码 `.ts` 插件。
- `tsc` 不复制 Markdown/JSON/hooks/skills，非 TS 资产需要构建脚本复制。
- 插件私有 Prompt 应放在插件自身的 `prompts/` 目录，通过 `import.meta.url` 相对插件模块解析；不要放进项目根目录的核心 Prompt 命名空间。
- prefix 重复会覆盖，虽然现在会 warning。
- `onMessage` 只是监听，不能阻止后续 Router 处理。
- 不要创建第二条 QQ 通道。

## 13. 验证插件系统

```bash
npm run typecheck
npm run build
npm test -- --run
```

验证构建后的 Steam 插件可 import：

```bash
node -e "import('./dist/plugins/steam/index.js').then(m=>{const p=new m.default(); console.log(p.name, p.ccPluginDir, p.commands.length, p.mcpServers.length)})"
```

预期输出：

```text
steam claude-plugin 1 1
```

验证构建后的 PluginSystem 能加载插件集并解析 ccPluginDir：

```text
plugins builtin-core,builtin-operations,builtin-session,builtin-workspace,steam
commands 11 default converse
mcp qqbot-steam
cc /path/to/project/dist/plugins/steam/claude-plugin
```
