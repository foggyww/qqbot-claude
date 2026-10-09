# Spec 0007: Steam Plugin

## Status
Accepted

## Scope

Steam 插件命令、Steam MCP server、Steam watcher、QQ 到 Steam ID 映射。主要涉及 `plugins/steam/` 和 `src/core/user_mapping.ts`。

## Goals

- Steam 插件在 Docker 和本机中都通过项目配置获得 API key。
- Steam MCP 工具对缺 key、缺 Steam ID、第三方 API 异常有明确返回。
- 订阅群每周收到按“玩家在具体游戏上的时长”排名的 Steam 最近两周榜单和简短 AI 锐评。
- 用户或 Agent 可以主动发布群成员绑定账号的 Steam 最近两周玩家游戏榜单。

## Rules

- Steam API key 支持 `STEAM_WEB_API_KEY` 和 `STEAM_API_KEY`。
- API key 应来自 `.qqbotrc.toml` `[env]` 或 `process.env`，不依赖宿主机 `.bashrc`。
- user mapping 默认路径必须是 `runtime/data/user_mapping.json`。
- 缺 API key 时必须返回明确错误。
- 缺 Steam ID 时必须返回明确错误。
- 调用 Steam API 时必须正确追加和 encode `key` 参数。
- 不得直接假设 Steam API 响应一定是 JSON。
- 榜单内部以 Steam `playtime_2weeks` 返回的分钟数计算，展示为小时和分钟。
- 榜单必须按群隔离，不能把其他群成员数据用于当前群。
- Steam 私有 Prompt 必须从 `plugins/steam/prompts/*.md` 读取并支持热更新，不能占用核心 Prompt 命名空间。
- 定时、命令和 MCP 最近两周榜必须复用同一个发布能力，不保存或推进本地游玩时长基线。
- Steam 实时状态通知有一个全局开关，持久化在 `runtime/data/steam_settings.json`，缺失或损坏时安全回退为开启。

## Behavior

- QQ 用户通过 `runtime/data/user_mapping.json` 映射到 Steam ID。
- MCP 工具根据 QQ 或 Steam ID 查询玩家资料、好友等数据。
- 非 JSON 响应、HTTP 非 2xx、JSON parse 失败都应返回结构化错误。
- `/steam weekly subscribe` 开启本群每周日自动发送最近两周榜单。
- `/steam notify on|off|status` 查询或切换全局实时状态通知，命令等级必须为 level 3；开关不区分群，也不影响周榜和主动最近两周榜。
- 全局实时通知关闭时，watcher 仍轮询并刷新 `steam_state.json` 基线，但在每次准备发送上下线、开始游戏或退出游戏通知时跳过发送，重新开启后不得补发停用期间的旧变化。
- watcher 向某个群发送实时通知失败时必须记录失败并继续处理其他群，不能让单群 OneBot 故障中断本轮通知。
- watcher 的周期 tick 必须在定时入口收敛所有异常，不能产生导致主进程退出的未处理 Promise rejection；手动 `/steam refresh` 遇到未预期异常或群通知发送失败时必须返回可诊断的失败文本。
- Steam HTTP 请求和响应体读取必须有超时与大小限制；网络失败返回安全错误，不返回带 key 的请求 URL。
- watcher 的定时和手动刷新共用同一个进行中的采集任务，不允许重叠写基线；停止或重新初始化后，旧采集不能继续写状态或发送通知。
- 同一 QQ 的多个 Steam ID 合并；同一群内跨 QQ 重复绑定的 Steam ID 仅确定性归属 QQ 号最小的成员，不重复计时。
- 每个 QQ 成员和每个游戏构成独立排名项；同一 QQ 的多个 Steam ID 在相同游戏上的时长合并，不同 QQ 玩同一游戏时不得互相累加。
- 所有玩家游戏排名项按分钟数全局降序排列，每行使用 `1. 玩家｜游戏｜27h56m` 格式展示名次、玩家群名片或昵称、游戏和时长。
- 榜单必须先发送；随后 AI 生成 3 至 5 条短评，每条单独发送。
- AI 失败、输出无效或短评发送失败不得导致榜单重发，也不得阻断其他群。
- 空榜单仍发送无游玩记录提示，但不调用 AI。
- `/steam recent` 在当前群主动发布最近两周榜单；`/steam 2weeks` 作为别名。
- MCP 工具 `steam_publish_group_recent_ranking` 接收白名单群号，并调用与命令相同的主动发布逻辑。
- 主动发布工具具有群消息副作用，返回结果必须说明榜单是否发送及锐评发送数量。
- 主动发布结果中的 `gameCount` 表示去重后的游戏数，`rankingEntryCount` 表示玩家游戏排名项数量。
- 同一群不能并发生成两份最近两周榜单。

## Error Handling

- 缺少 Steam ID 返回 `{ error: "未找到 Steam ID" }` 或同等清晰结构。
- HTTP 错误应包含状态码和安全截断后的响应摘要。
- JSON parse 错误不得抛出未处理异常。
- 单个 Steam 账号查询失败时跳过该账号；全部失败时不发送榜单。
- Steam 返回空 `response` 时视为游戏详情不可见，不得计作 API 获取失败；榜单应分别提示不可见账号数和真正获取失败账号数。
- `total_count` 表示结果总数，允许大于本次返回的 `games` 数组长度；`games` 数组长度不得大于 `total_count`。
- MCP 主动发布必须在工具内部校验正整数群号和群白名单，不能依赖 Router 权限。

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
- `playtime_2weeks` 严格解析、玩家游戏聚合排序、群隔离和重复绑定。
- 部分 API 失败、同群并发触发阻止和空榜单。
- 榜单与 AI 短评发送顺序、短评数量限制及 AI 失败降级。
- `playtime_2weeks` 解析、主动榜单聚合、白名单校验和并发阻止。
- 全局实时通知开关的默认值、持久化、level 3 命令声明，以及关闭时只跳过发送而继续推进状态基线。
- 单群通知发送失败不阻断其他群，周期 tick 的 rejection 不向进程冒泡。

## Acceptance Checklist

- [ ] user mapping 路径仍是 `runtime/data/user_mapping.json`。
- [ ] Steam API key 不泄漏。
- [ ] 第三方 API 错误结构化返回。
- [ ] 只有 level 3 管理员可切换 Steam 全局实时通知。
