# QQBot 插件开发指南

> 完整工作原理见 [`plugin-system.md`](plugin-system.md)。本文偏向快速开发指南。

## 概述

QQBot 插件是一个标准的 npm 包，实现了 `Plugin` 接口：

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

## 最小插件示例

```ts
// my-plugin/src/index.ts
import type { Plugin } from "qqbot";

const plugin: Plugin = {
  name: "hello",
  version: "1.0.0",
  description: "一个打招呼的插件",
  commands: [
    {
      name: "hello",
      description: "回复你好",
      prefix: "/hello",         // 完整触发前缀
      minLevel: 0,              // 最低角色等级
      handler: async (_msg, _sessionDir, ctx) => {
        return `你好，${ctx.senderNick}！`;
      },
    },
  ],
};

export default plugin;
```

然后在 `package.json` 中声明入口：

```json
{
  "name": "qqbot-plugin-hello",
  "main": "dist/index.js",
  "files": ["dist"],
  "peerDependencies": {
    "qqbot": ">=3.0"
  }
}
```

## Command 注册方法

每个插件通过 `commands` 数组注册命令。`Command` 接口：

```ts
interface Command {
  name: string;                  // 命令名（唯一）
  description: string;           // 帮助文本
  prefix?: string;               // 前缀，如 "!"、"#"
  isDefault?: boolean;           // 设为默认对话处理器
  isSetter?: boolean;            // 无参调用时切换状态
  minLevel: 0 | 1 | 2 | 3;      // 0=访客 1=用户 2=可信用户 3=管理员
  requireRoot?: boolean;         // 仅 root 会话可用
  handler: (msg: string, sessionDir: string, ctx: MessageContext) => Promise<string | void>;
}
```

### 命令匹配规则

- 消息等于 `prefix` 或以 `prefix + 空格` 开头时触发该命令（如 `/hello`）
- 设置了 `isDefault: true` 的命令在无前缀匹配时作为默认对话处理器
- `msg` 参数为去掉完整 `prefix` 后的剩余文本
- 返回 `string` 会发送给用户，返回 `void` 或 `undefined` 表示静默处理

## 生命周期钩子

| 钩子 | 时机 | 典型用途 |
|------|------|----------|
| `onLoad(ctx)` | 插件加载后 | 初始化资源、注册定时任务 |
| `onUnload(ctx)` | 插件卸载前 | 清理资源、取消定时器 |
| `onMessage(ctx)` | 每次收到消息 | 日志记录、消息审计 |

`BotContext` 提供给插件的上下文：

```ts
interface BotContext {
  config: BotConfig;                                    // 完整配置
  sessionDir: string;                                   // 会话存储目录
  adapter: QQAdapter;                                   // 当前 QQ 适配器
  sessionStore: SessionStore;                           // 会话状态读写
  sendMessage(type, target, message): Promise<void>;    // 主动发消息
  logger: Logger;                                       // 日志接口
  scheduler: SchedulerRef;                              // 定时任务接口
}
```

## 插件 MCP server

插件可以通过 `mcpServers` 提供工具。所有 MCP server 会被 `PluginSystem` 聚合，并由项目内 `McpHost` 统一暴露。

```ts
import type { McpServer, Plugin } from "qqbot";

const server: McpServer = {
  name: "my-plugin",
  version: "1.0.0",
  tools: [
    {
      name: "hello_tool",
      description: "返回问候语",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
  async handleToolCall(name, args) {
    if (name === "hello_tool") return "hello";
    throw new Error(`Unknown tool: ${name}`);
  },
};

export default class MyPlugin implements Plugin {
  name = "my-plugin";
  version = "1.0.0";
  mcpServers = [server];
}
```

如果插件需要操作 QQ，优先使用 `BotContext.adapter` 或 `BotContext.sendMessage`，不要创建第二条 QQ 通道。

## 如何发布 npm 包

1. **目录结构**

```
qqbot-plugin-hello/
├── src/
│   └── index.ts        # 插件入口
├── package.json
├── tsconfig.json
└── README.md
```

2. **package.json 关键字段**

```json
{
  "name": "qqbot-plugin-<功能名>",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "keywords": ["qqbot", "qqbot-plugin"],
  "peerDependencies": {
    "qqbot": ">=3.0"
  }
}
```

3. **构建并发布**

```bash
npm run build          # tsc 编译
npm publish --access public
```

发布后，用户在 QQBot 项目中 `npm install qqbot-plugin-hello` 即可自动加载。
