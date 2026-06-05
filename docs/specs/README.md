# Specs

`docs/specs/` 存放项目的行为规格。spec 不是普通说明文档，而是开发和 review 的验收依据。

## 什么时候必须新增或更新 spec

以下修改必须新增或更新相关 spec：

- 新增模块、公共 API、命令、插件或 MCP 工具。
- 修改消息流、权限、配置、runtime 路径、AI backend、MCP、插件系统、调度器。
- 修改跨模块架构边界或长期行为。
- 修复一个暴露出规则缺失的 bug。

小型 typo、纯注释、内部 helper 的局部修复可以不新增 spec，但不能违反现有 spec。

## Spec 模板

```markdown
# Spec NNNN: 名称

## Status
Draft | Accepted | Deprecated

## Scope
涉及的文件、模块、命令或插件。

## Goals
本 spec 要保证的目标。

## Non-goals
明确不覆盖什么，避免误解。

## Rules
- 必须……
- 禁止……
- 默认……

## Behavior
输入、输出、状态变化、边界情况。

## Error Handling
错误如何记录、返回、恢复。

## Security
密钥、隐私、权限、文件读写限制。

## Tests
修改本范围时应新增或执行哪些测试。

## Acceptance Checklist
- [ ] 符合本 spec
- [ ] 相关测试通过
- [ ] `npm run typecheck` 通过
- [ ] 已检查密钥、隐私和运行时数据未进入 diff
- [ ] 已由独立 subagent review（非平凡代码修改）
```

## 当前 specs

- `0001-message-flow.md`：消息处理链路
- `0002-permission.md`：权限和群白名单
- `0003-config-runtime.md`：配置、runtime、Docker/本机路径
- `0004-ai-backend.md`：Claude Code backend
- `0005-mcp.md`：MCP Host 和 MCP 工具
- `0006-plugin-api.md`：插件接口和生命周期
- `0007-steam-plugin.md`：Steam 插件
- `0008-scheduler.md`：任务调度
