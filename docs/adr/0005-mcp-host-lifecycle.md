# ADR-0005: MCP Host Lifecycle

## Status
Accepted

## Context

Claude Code 需要通过 MCP 工具调用 QQ 和插件能力。MCP Host 如果独立于 Bot 生命周期运行，会带来 adapter 注入、连接复用、端口清理和插件加载顺序问题。

## Decision

MCP Host 是 qqbot 进程内服务，随 `Bot.start()` 启动，随 `Bot.stop()` 停止。内置和插件 MCP server 都注册到这个 Host。

## Rationale

- MCP 工具可直接复用当前 `QQAdapter`。
- 插件加载后统一暴露 MCP server。
- 生命周期集中，避免端口泄漏和重复 host。

## Consequences

- 插件只提供 `McpServer`，不应自己管理全局 MCP Host。
- 内置 QQ MCP server 不创建新 QQ 连接。
- MCP 监听地址和端口通过环境变量覆盖，但默认只监听本机地址。
