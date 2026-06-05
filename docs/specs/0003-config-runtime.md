# Spec 0003: Config and Runtime Paths

## Status
Accepted

## Scope

`.qqbotrc.toml`、`.env`、配置加载、Docker Compose、本机运行、runtime 数据目录。主要涉及 `src/core/config.ts`、`.qqbotrc.toml.example`、`.env.example`、`docker-compose.yml`、`Dockerfile`、`scripts/install.mjs`、`scripts/setup-docker.sh`、`scripts/docker-entrypoint.mjs`。

## Goals

- Docker 推荐部署和本机备用部署都能闭环运行。
- qqbot 只有一个主配置来源。
- 运行时数据不污染源码目录，也不回退到旧路径。

## Rules

- `.qqbotrc.toml` 是 qqbot 主配置，Docker 和本机默认共用项目根目录同一份文件。
- `.env` 仅用于 Docker Compose / NapCat 编排变量，例如 `BOT_QQ`、`NAPCAT_MODE`、`ONEBOT_WS_URL`。
- 默认运行数据必须在 `runtime/` 下。
- 默认数据目录是 `runtime/data`。
- 默认会话目录是 `runtime/sessions`。
- 默认工作区是 `runtime/workspace`。
- 默认 Claude projects 目录是 `runtime/.claude/projects`。
- 禁止 fallback 到旧 `./data`。
- `data/` 仅可能作为迁移前备份或 gitignore 遗留名称存在，新代码不得读取或写入该目录。
- NapCat 登录态和配置必须由 NapCat 自己的 volume 管理，不能混入 qqbot runtime。

## Behavior

- Docker 中 qqbot 服务挂载 `.qqbotrc.toml` 并使用 `/app/runtime` 保存运行数据。
- 本机运行使用项目目录下 `./runtime` 保存运行数据。
- 环境变量可覆盖网络拓扑差异，例如 `ONEBOT_WS_URL`，但不能生成第二套 qqbot 主配置。

## Error Handling

- `.qqbotrc.toml` 缺失时应给出安装/setup 指引。
- runtime 子目录缺失时应创建。
- 配置解析错误必须明确报错。
- `[qq].account` 必须是正整数；`[onebot].ws_url` 必须以 `ws://` 或 `wss://` 开头。
- 非法 timeout、Steam watcher 间隔、角色等级等可疑配置应告警并使用安全默认值或跳过。

## Security

- `.qqbotrc.toml`、`.env`、`runtime/`、`data.migrated-*/` 禁止提交。
- 不打印 `[env]` 段中的密钥。
- Docker build context 不应包含私有配置或运行时数据。

## Tests

修改本范围时优先更新：

- `tests/config.test.ts`
- Docker/setup 相关修改还应执行 `docker compose config --quiet` 和 shell 语法检查。

## Acceptance Checklist

- [ ] 默认路径仍指向 `runtime/`。
- [ ] 不存在旧 `data/` fallback。
- [ ] `.env` 没有变成 qqbot 主配置。
- [ ] Docker 和本机说明一致。
- [ ] 配置错误能在启动早期给出明确报错或告警。
