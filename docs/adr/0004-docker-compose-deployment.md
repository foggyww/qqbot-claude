# ADR-0004: Docker Compose Recommended Deployment

## Status
Accepted

## Context

目标用户可能不熟悉 Node.js、Claude Code CLI、NapCat 安装和系统服务管理。项目需要提供服务器上一键部署的推荐路径，同时保留本机开发/备用运行方式。

## Decision

推荐部署方式是 Docker Compose，包含两个主要服务：

- `qqbot`：本项目和 Claude Code CLI。
- `napcat`：NapCat / OneBot 服务。

本机运行保留为开发和备用方式。

## Rationale

- 宿主机无需安装 Node.js、Claude Code CLI 或 NapCat。
- qqbot 与 NapCat 生命周期和数据 volume 清晰分离。
- Docker Compose 便于新手部署和重启。

## Consequences

- `docker-compose.yml` 是公开推荐部署入口。
- `.env` 仅作为 Compose/NapCat 编排变量，不作为 qqbot 主配置。
- Docker 和本机共用项目根目录同一份 `.qqbotrc.toml`。
- NapCat 登录态和配置由 NapCat volume 管理，不进入 qqbot runtime。
