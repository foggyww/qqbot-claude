# Spec 0002: Permission

## Status
Accepted

## Scope

角色等级、管理员、可信用户、群白名单、动态授权和 `/auth` 命令。主要涉及 `src/core/permission.ts`、`src/plugin/builtin/auth.ts`、`src/core/config.ts`、`runtime/data/auth.json`。

## Goals

- 让 QQ 用户权限清晰、可测试、可动态更新。
- 防止访客或未授权群触发高权限命令。

## Rules

- 权限等级固定为：0 访客、1 用户、2 可信用户、3 管理员。
- 管理员来自 `.qqbotrc.toml` `[roles].admins` 或动态授权合并结果。
- `/auth` 只能由管理员执行。
- 动态授权文件默认只能是 `runtime/data/auth.json`。
- 群聊必须满足白名单规则后才允许进入命令分发。
- 命令必须声明 `minLevel`；缺失时不得默认为高权限。
- `requireRoot` 命令必须额外检查 root 模式或管理员权限，不能只依赖 `minLevel`。

## Behavior

- 访客私聊默认拒绝。
- 白名单群中的普通用户可以使用 level 1 命令。
- 可信用户可以使用 level 2 命令。
- 管理员可以使用 level 3 命令和授权管理命令。

## Error Handling

- 权限不足应返回明确但简短的提示。
- 动态授权文件损坏时应记录错误，并使用静态配置继续运行或明确启动失败；不能静默扩大权限。

## Security

- 不能把授权文件写到旧 `data/`。
- 授权变更不得打印完整私有配置。
- `/auth` 不能允许非管理员提权自己或他人。

## Tests

修改本范围时优先更新：

- `tests/permission.test.ts`
- `tests/config.test.ts`
- `tests/router.test.ts`

## Acceptance Checklist

- [ ] 访客、用户、可信用户、管理员行为均被覆盖。
- [ ] `/auth` 不允许非管理员使用。
- [ ] 动态授权路径保持在 `runtime/data/auth.json`。
