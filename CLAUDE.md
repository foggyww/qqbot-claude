# Claude Code Compatibility Entry

本文件仅作为 Claude Code 等旧工具的兼容入口。项目的通用 AI agent 规则已经迁移到：

- `AGENTS.md`

OpenCode、Claude Code、Codex、Cursor agent 以及其他自动化编码助手都应优先阅读并遵守 `AGENTS.md`。

## 必读文档

开始非平凡修改前，按需阅读：

1. `AGENTS.md`
2. `docs/architecture.md`
3. 相关 `docs/specs/*.md`
4. 相关 `docs/adr/*.md`
5. 涉及插件时阅读 `docs/plugin-guide.md` 和 `docs/plugin-system.md`
6. 涉及风格、错误、安全、测试时阅读：
   - `docs/code-style.md`
   - `docs/error-handling.md`
   - `docs/security.md`
   - `docs/testing.md`

## 项目快速索引

- 项目架构：`docs/architecture.md`
- 插件开发：`docs/plugin-guide.md`
- 插件系统：`docs/plugin-system.md`
- 行为规格：`docs/specs/`
- 架构决策：`docs/adr/`
- 通用 agent 规则：`AGENTS.md`

## 常用命令

```bash
npm run dev          # tsx watch 模式
npm run setup        # Docker 推荐安装入口
npm run setup:docker # 生成 .qqbotrc.toml + .env
npm run setup:local  # 本机备用部署安装向导
npm run verify       # 检查本机运行环境
npm run build        # tsc 编译
npm run typecheck    # 类型检查
npm run lint         # eslint
npm test             # vitest
```
