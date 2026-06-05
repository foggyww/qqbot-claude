# Spec 0007: Steam Plugin

## Status
Accepted

## Scope

Steam 插件命令、Steam MCP server、Steam watcher、QQ 到 Steam ID 映射。主要涉及 `plugins/steam/` 和 `src/core/user_mapping.ts`。

## Goals

- Steam 插件在 Docker 和本机中都通过项目配置获得 API key。
- Steam MCP 工具对缺 key、缺 Steam ID、第三方 API 异常有明确返回。

## Rules

- Steam API key 支持 `STEAM_WEB_API_KEY` 和 `STEAM_API_KEY`。
- API key 应来自 `.qqbotrc.toml` `[env]` 或 `process.env`，不依赖宿主机 `.bashrc`。
- user mapping 默认路径必须是 `runtime/data/user_mapping.json`。
- 缺 API key 时必须返回明确错误。
- 缺 Steam ID 时必须返回明确错误。
- 调用 Steam API 时必须正确追加和 encode `key` 参数。
- 不得直接假设 Steam API 响应一定是 JSON。

## Behavior

- QQ 用户通过 `runtime/data/user_mapping.json` 映射到 Steam ID。
- MCP 工具根据 QQ 或 Steam ID 查询玩家资料、好友等数据。
- 非 JSON 响应、HTTP 非 2xx、JSON parse 失败都应返回结构化错误。

## Error Handling

- 缺少 Steam ID 返回 `{ error: "未找到 Steam ID" }` 或同等清晰结构。
- HTTP 错误应包含状态码和安全截断后的响应摘要。
- JSON parse 错误不得抛出未处理异常。

## Security

- 不打印 Steam API key。
- 不把真实 user mapping 或用户隐私提交到仓库。
- 第三方 API 响应日志应截断。

## Tests

修改本范围时应考虑新增 Steam 插件测试，覆盖：

- 缺 key。
- 缺 Steam ID。
- HTTP 非 2xx。
- 非 JSON 响应。
- 正常 JSON 响应。

## Acceptance Checklist

- [ ] user mapping 路径仍是 `runtime/data/user_mapping.json`。
- [ ] Steam API key 不泄漏。
- [ ] 第三方 API 错误结构化返回。
