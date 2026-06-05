# Spec 0001: Message Flow

## Status
Accepted

## Scope

消息从 OneBot WebSocket 进入项目后，到插件被动监听、路由分发、命令执行、默认对话触发的完整流程。主要涉及 `src/adapter/onebot.ts`、`src/core/bot.ts`、`src/core/context.ts`、`src/core/router.ts`、`src/plugin/index.ts`。

## Goals

- 保证私聊、群聊、插件监听、默认对话的触发条件稳定可预期。
- 避免未授权用户或未白名单群触发 AI。
- 保留用户消息意图，尤其是群聊 CQ 码和 @ 关系。

## Rules

- OneBot event 必须先转换为 `MessageContext`，再进入插件或路由。
- `PluginSystem.onMessage()` 必须先于 `router.dispatchMessage()` 执行。
- 插件被动监听异常不能阻断主路由。
- 私聊必须经过权限检查后才能执行命令或默认对话。
- 群聊必须先检查白名单，再检查是否 @bot。
- 群聊未 @bot 时不得触发默认 AI 对话。
- 删除 `@bot` 自己的 CQ 码时，必须保留 @其他人的 CQ 码。
- 消息 session key 必须稳定：私聊 `private_{QQ}`，群聊 `group_{群号}`。

## Behavior

```text
OneBot message event
  → OneBotAdapter.parse
  → Bot.handleIncomingMessage
  → PluginSystem.onMessage
  → router.dispatchMessage
    → private: permission → command/default handler
    → group: cache → whitelist → @bot → command/default handler
```

空 @bot 行为应由路由明确处理：可以提示用户输入内容或按既有默认行为处理，但不能把空内容误认为任意命令。

## Error Handling

- Adapter 解析失败应记录并丢弃该 event，不影响 WebSocket 连接。
- 插件 `onMessage` 抛错必须被捕获和记录。
- 命令 handler 抛错应转换为用户可理解的失败响应。

## Security

- 未授权私聊和未白名单群不能进入 AI backend。
- 群消息缓存不得写入公开文件或测试 fixture。
- 日志不得打印密钥或完整私有配置。

## Tests

修改本范围时优先更新：

- `tests/context.test.ts`
- `tests/router.test.ts`
- `tests/plugin-system.test.ts`

## Acceptance Checklist

- [ ] 私聊权限行为符合 spec。
- [ ] 群聊白名单和 @bot 行为符合 spec。
- [ ] 插件异常不会阻断主路由。
- [ ] `npm run typecheck` 和 `npm test -- --run` 通过。
