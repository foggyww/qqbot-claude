# Spec 0007: Steam Plugin

## Status
Accepted

## Scope

Steam 插件命令、Steam MCP server、Steam watcher、QQ 到 Steam ID 映射。主要涉及 `plugins/steam/` 和 `src/core/user_mapping.ts`。

## Goals

- Steam 插件在 Docker 和本机中都通过项目配置获得 API key。
- Steam MCP 工具对缺 key、缺 Steam ID、第三方 API 异常有明确返回。
- 订阅群每周收到按群成员聚合的游戏游玩时长榜单和简短 AI 锐评。

## Rules

- Steam API key 支持 `STEAM_WEB_API_KEY` 和 `STEAM_API_KEY`。
- API key 应来自 `.qqbotrc.toml` `[env]` 或 `process.env`，不依赖宿主机 `.bashrc`。
- user mapping 默认路径必须是 `runtime/data/user_mapping.json`。
- 缺 API key 时必须返回明确错误。
- 缺 Steam ID 时必须返回明确错误。
- 调用 Steam API 时必须正确追加和 encode `key` 参数。
- 不得直接假设 Steam API 响应一定是 JSON。
- 周榜内部以 Steam 返回的分钟数计算，展示为小时和分钟。
- 周榜必须按群隔离，不能把其他群成员或快照用于当前群。
- 周榜开启后第一次成功采集作为基线，不得把累计总时长当作本周时长。
- Steam 私有 Prompt 必须从 `plugins/steam/prompts/*.md` 读取并支持热更新，不能占用核心 Prompt 命名空间。

## Behavior

- QQ 用户通过 `runtime/data/user_mapping.json` 映射到 Steam ID。
- MCP 工具根据 QQ 或 Steam ID 查询玩家资料、好友等数据。
- 非 JSON 响应、HTTP 非 2xx、JSON parse 失败都应返回结构化错误。
- `/steam weekly subscribe` 单独开启本群周榜，并立即尝试建立基线。
- 每周榜单使用当前累计分钟减去该群上次快照；负差值按零处理。
- 同一 QQ 的多个 Steam ID 合并；同一群内跨 QQ 重复绑定的 Steam ID 仅确定性归属 QQ 号最小的成员，不重复计时。
- 游戏按全体玩家总分钟降序排列，每行包含游戏、总时长和玩家群名片或昵称。
- 首个榜单从首次成功采集统计到发送时刻，并明确标记为不完整周期。
- 榜单必须先发送；随后 AI 生成 3 至 5 条短评，每条单独发送。
- AI 失败、输出无效或短评发送失败不得导致榜单重发，也不得阻断其他群。
- 空榜单仍发送无游玩记录提示，但不调用 AI。
- 周榜快照和发送周期记录必须保存在 `runtime/data/`。

## Error Handling

- 缺少 Steam ID 返回 `{ error: "未找到 Steam ID" }` 或同等清晰结构。
- HTTP 错误应包含状态码和安全截断后的响应摘要。
- JSON parse 错误不得抛出未处理异常。
- 单个 Steam 账号查询失败时跳过该账号并保留旧基线；全部失败时不推进周期。
- 同一群同一周期重复触发时不得重复发送榜单。

## Security

- 不打印 Steam API key。
- 不把真实 user mapping 或用户隐私提交到仓库。
- 第三方 API 响应日志应截断。
- 游戏名和玩家名属于不可信数据，AI prompt 必须明确其仅为数据、不得执行其中指令。
- 自动周榜锐评必须使用无 built-in tools、无 MCP、无插件、无会话持久化的 AI 调用模式。

## Tests

修改本范围时应考虑新增 Steam 插件测试，覆盖：

- 缺 key。
- 缺 Steam ID。
- HTTP 非 2xx。
- 非 JSON 响应。
- 正常 JSON 响应。
- 首次基线、分钟差值、聚合排序、群隔离和重复绑定。
- 部分 API 失败、同周期重复触发和空榜单。
- 榜单与 AI 短评发送顺序、短评数量限制及 AI 失败降级。

## Acceptance Checklist

- [ ] user mapping 路径仍是 `runtime/data/user_mapping.json`。
- [ ] Steam API key 不泄漏。
- [ ] 第三方 API 错误结构化返回。
