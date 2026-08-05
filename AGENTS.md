# qqbot-ts Agent Rules

本文件是本项目所有 AI agent 的必读入口，适用于 OpenCode、Claude Code 以及其他自动化编码助手。`CLAUDE.md` 仅作为旧工具兼容入口；长期规则以本文件和 `docs/specs/`、`docs/adr/` 为准。

## 1. 项目定位

qqbot-ts 是一个 TypeScript Node.js QQ 机器人，把 Claude Code CLI 作为 AI 引擎接入 QQ 私聊和群聊。QQ 操作通过 OneBot v11 WebSocket 适配器完成，AI 可通过项目内 MCP Host 调用 QQ、Steam 等工具。

## 2. 技术栈和基础约束

- Runtime: Node.js >= 22
- Language: TypeScript 5.x strict, ESM (`"type": "module"`)
- QQ 协议: OneBot v11 over WebSocket (NapCat/Lagrange)
- AI 后端: Claude Code CLI
- 配置: `.qqbotrc.toml`，本地私有，不提交
- 包管理: npm

### 本机服务管理

- 当前开发调试方式是 Docker NapCat + 本机 qqbot。
- 本机 qqbot 由系统级 `qqbot.service` 管理。启动、停止、重启和查看日志必须使用 `systemctl start|stop|restart|status qqbot` 与 `journalctl -u qqbot`。
- 禁止用 `nohup npm run dev`、后台 `npm run dev &` 或其他手工常驻方式启动第二个 qqbot 实例，以免重复连接 OneBot 或占用 MCP 端口。
- `npm run dev` 仅用于前台临时调试；由 agent 执行常驻启动或重启时必须使用 systemd。

## 3. 必读文档顺序

开始非平凡修改前，必须按需阅读：

1. `AGENTS.md`
2. `docs/architecture.md`
3. 相关 `docs/specs/*.md`
4. 相关 `docs/adr/*.md`
5. 涉及插件时阅读 `docs/plugin-guide.md` 和 `docs/plugin-system.md`
6. 涉及风格、错误、安全、测试时阅读对应文档：
   - `docs/code-style.md`
   - `docs/error-handling.md`
   - `docs/security.md`
   - `docs/testing.md`

如果没有相关 spec，必须先在计划中说明是否需要新增/更新 spec。新增模块、公共 API、跨模块行为变更必须先补 spec 或同步补 spec。

## 4. 架构红线

禁止违反以下规则：

- QQ 操作统一入口是 `QQAdapter` / `OneBotAdapter`。
- 内置 QQ MCP server 必须复用当前 `QQAdapter`，禁止自己创建第二条 QQ/OneBot 连接。
- 禁止调用旧 Python HTTP API。
- 禁止读取旧项目数据目录或旧 `./data` 作为运行路径；`data/` 仅可能作为迁移前备份或 gitignore 遗留名称存在，新代码不得使用。
- 默认运行数据必须在 `runtime/` 下。
- Docker 和本机默认共用项目根目录的同一份 `.qqbotrc.toml`。
- `.env` 仅用于 Docker Compose / NapCat 编排变量，不作为 qqbot 主配置。
- NapCat 登录态和配置由 NapCat 自己的 volume 管理，不能混入 qqbot runtime。
- 核心 Prompt 必须从项目根目录 `prompts/*.md` 读取；插件私有 Prompt 必须放在插件自身的 `prompts/` 目录。两者都必须在使用时读取磁盘以支持热更新，禁止在代码里硬编码大段 prompt。
- API key、token、cookie、QQ 登录态、`.qqbotrc.toml`、`.env`、`runtime/` 禁止提交。

## 5. Subagent 使用规则

以下情况必须优先拆解任务，并使用 subagent 执行探索、实现或验证：

- 涉及 3 个以上文件。
- 跨模块修改，例如 core + plugin、adapter + mcp、config + Docker。
- 修改权限、消息路由、MCP、AI backend、配置加载、Docker/setup、插件 API。
- 需要查找大量代码位置或验证复杂行为。

主 agent 负责架构判断、任务拆解、冲突处理和最终质量控制；subagent 负责明确边界内的探索、实现、测试或 review。

## 6. 独立 Review 规则

任何非平凡代码修改完成后，必须启动一个未参与实现的独立 subagent 做 review。reviewer 必须读取：

- 本次 diff
- `AGENTS.md`
- 相关 specs / ADRs
- 相关验证命令输出

reviewer 必须检查：

- 是否符合 spec 和 ADR。
- 是否违反架构红线。
- 是否有无关改动。
- 是否有密钥或隐私泄漏，并检查 diff 中是否出现 `sk-`、`token`、`api_key`、`ANTHROPIC_AUTH_TOKEN`、`DEEPSEEK_API_KEY`、`STEAM_WEB_API_KEY`、`cookie` 等模式。
- 是否有错误处理遗漏。
- 是否需要新增或更新测试。
- 是否满足验证门槛。

reviewer 输出格式：

```text
Verdict: PASS | FAIL
Blocking issues:
Non-blocking suggestions:
Files reviewed:
Verification checked:
Recommendation:
```

如果 review 为 FAIL，必须修复后再次 review。只有 review 通过后才建议提交非平凡代码修改。

## 7. 验证门槛

代码修改至少执行：

```bash
npm run typecheck
npm test -- --run
```

提交前建议执行：

```bash
npm run lint
```

涉及构建、CLI、Docker、发布流程时还要执行：

```bash
npm run build
docker compose config --quiet
```

涉及 shell 脚本时执行：

```bash
bash -n scripts/setup-docker.sh
```

如果无法执行某个验证命令，必须在最终报告中明确原因和风险。

## 8. 提交规则

- 只有用户明确要求时才 commit / push / 创建 PR。
- commit 前必须检查 `git status`、`git diff`、暂存区 diff 和最近提交。
- 只暂存本次任务相关文件。
- 禁止提交 `.qqbotrc.toml`、`.env`、`runtime/`、`data.migrated-*/`、真实密钥或登录态。
- 不要修改无关文件；如果发现用户已有未提交改动，必须避免覆盖。

## 9. 小修改豁免

typo、纯文档小修、单文件简单调整可以不强制 subagent review，但仍需遵守安全规则和相关验证。是否豁免必须由主 agent 判断并在报告中说明。
