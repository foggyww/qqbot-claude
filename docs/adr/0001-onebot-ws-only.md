# ADR-0001: OneBot WebSocket Only

## Status
Accepted

## Context

项目需要通过 QQ 收发消息、查询群成员和历史、撤回消息等。历史上存在旧 Python HTTP API 或其他 QQ 通道，但多通道会导致连接状态、权限、错误处理和测试边界复杂化。

## Decision

qqbot-ts 统一使用 OneBot v11 over WebSocket 作为 QQ 协议通道。项目内 QQ 能力通过 `QQAdapter` 抽象，并由 `OneBotAdapter` 实现。

## Rationale

- 单一通道便于维护连接生命周期和重连。
- Adapter 抽象便于测试和未来替换实现。
- MCP、插件、路由共用同一能力边界，避免重复连接和状态不一致。

## Consequences

- 所有 QQ 操作必须通过 `QQAdapter` / `OneBotAdapter`。
- MCP server 和插件不得自己新建第二条 QQ/OneBot 连接。
- 不新增旧 HTTP API 依赖。
