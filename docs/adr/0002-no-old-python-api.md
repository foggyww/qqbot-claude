# ADR-0002: No Old Python API or Data Directory

## Status
Accepted

## Context

qqbot-ts 的目标是用 TypeScript 独立实现机器人能力。继续依赖旧 Python 项目的 HTTP API 或数据目录会让部署、测试和迁移变得不可控。

## Decision

qqbot-ts 不调用旧 Python HTTP API，不读取旧项目数据目录，不把旧 `./data` 作为运行路径 fallback。

## Rationale

- TypeScript 项目应自包含运行。
- Docker 和本机部署需要一致路径模型。
- 旧数据格式可能不稳定，不能作为新代码隐式依赖。

## Consequences

- 旧数据只能通过显式迁移进入 `runtime/`。
- 新代码不能 fallback 到旧 `data/`。
- 修复历史兼容问题时应优先写迁移或导入逻辑，而不是恢复旧路径依赖。
