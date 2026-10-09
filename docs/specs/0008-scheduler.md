# Spec 0008: Scheduler

## Status
Accepted

## Scope

cron / interval 定时任务、任务触发、持久化和恢复。主要涉及 `src/scheduler/index.ts` 和内置 schedule 命令。

## Goals

- 定时任务在 Bot 生命周期内稳定运行。
- 任务触发时能通过 Claude backend 和 MCP 工具完成回复。

## Rules

- 调度器应由 Bot 生命周期管理。
- 定时回调必须清除创建任务时继承的 QQ 写账上下文，不得借用旧消息的写权限；自动定时任务的 AI 只可查询账本。
- 定时任务数据必须保存在 `runtime/` 下的项目数据路径。
- 任务触发 prompt 必须明确要求完成后只输出 `ok` 或符合既有行为。
- 定时任务不得绕过权限创建。
- 停止 Bot 时应释放 interval/cron 资源。
- cron 字段只接受范围内的整数、通配符、列表、递增区间及正整数步长；非法表达式在注册时拒绝，不允许截断、取默认步长或无限循环。
- interval 分钟数必须有限且大于零，对应毫秒必须在 Node 定时器范围内；同一任务尚未完成时跳过新的 interval tick。
- 定时 AI 任务与相同会话的消息处理共享会话队列，避免并发修改 Claude 会话。

## Behavior

- 支持 cron 和 interval 类型任务。
- 任务触发时调用 Claude backend，并附加系统提示。
- 任务恢复时应读取 runtime 中的持久化数据。

## Error Handling

- 单个任务失败不能阻断其他任务。
- 任务执行错误应记录任务标识和安全错误摘要。
- 持久化数据损坏时应明确报错或跳过损坏任务，不能静默执行未知任务。
- 持久化文件必须为任务数组；逐项验证任务名称、内容、cron 和 enabled，不合格项隔离，不影响有效任务恢复。
- 同步抛错和 Promise 拒绝都由调度器隔离；任务替换或停止后，旧执行的完成回调不能重建任务。

## Security

- 任务内容可能包含用户数据，不能提交到仓库。
- 任务创建权限必须符合权限 spec。

## Tests

修改本范围时应考虑新增 scheduler 测试，覆盖任务创建、触发、停止和错误路径。

## Acceptance Checklist

- [ ] 调度器随 Bot 生命周期释放资源。
- [ ] 任务数据留在 `runtime/`。
- [ ] 单任务失败不影响其他任务。
