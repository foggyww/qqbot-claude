# ADR-0003: Runtime Directory

## Status
Accepted

## Context

机器人运行会产生授权数据、会话状态、Claude projects、workspace、插件数据等。如果这些数据散落在项目根目录、用户 home 或旧路径中，会影响 Docker、本机和备份迁移。

## Decision

默认运行数据统一放在项目 runtime 目录下：

- `runtime/data`
- `runtime/sessions`
- `runtime/workspace`
- `runtime/.claude/projects`

Docker 中对应 `/app/runtime`，并通过 Docker volume 持久化。

## Rationale

- 路径集中，便于备份、清理、忽略和迁移。
- Docker 和本机行为一致。
- 避免误提交运行时数据。

## Consequences

- `runtime/` 必须 gitignore。
- 代码不得默认读取旧 `data/`。
- 文档、setup、Docker 和测试必须围绕 runtime 路径设计。
