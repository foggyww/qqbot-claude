# Spec 0006: Plugin API

## Status
Accepted

## Scope

插件接口、命令注册、插件生命周期、插件 MCP、Claude Code 原生插件目录。主要涉及 `src/core/types.ts`、`src/plugin/index.ts`、`src/plugin/builtin/` 和 `plugins/`。

## Goals

- 插件能扩展命令、MCP、被动监听和 Claude Code 能力。
- 插件不能破坏核心生命周期和 QQ 连接单一入口。

## Rules

- 插件入口应导出符合 `Plugin` 接口的对象。
- 插件命令必须声明 `name`、`description`、`minLevel` 和 handler。
- 插件生命周期通过 `onLoad` / `onUnload` 管理。
- 插件被动监听通过 `onMessage`，异常必须被插件系统捕获。
- 插件 MCP 必须通过 `mcpServers` 暴露。
- 插件不得私自启动重复 QQ 连接。
- 插件不得依赖旧项目数据目录。

## Behavior

- `PluginSystem` 加载内置插件和 `plugins/` 下的外部插件。
- 插件命令注册到 router。
- 插件 `ccPluginDir` 收集后传给 Claude Code backend。
- 插件卸载时应释放 watcher、timer、server 等资源。

## Error Handling

- 插件加载失败应记录插件名和错误，不应泄漏密钥。
- `onLoad` / `onUnload` 失败必须可诊断。
- `onMessage` 失败不能阻断其他插件和主路由。

## Security

- 插件访问密钥应通过 `.qqbotrc.toml` `[env]` 或 `process.env`。
- 插件不得打印完整密钥。
- 插件读写数据应使用 `runtime/` 或插件明确的安全路径。

## Tests

修改本范围时优先更新：

- `tests/plugin-system.test.ts`
- 相关 router/config 测试

## Acceptance Checklist

- [ ] 插件生命周期符合 spec。
- [ ] 命令权限声明完整。
- [ ] 插件异常被捕获。
