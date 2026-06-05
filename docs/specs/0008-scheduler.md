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
- 定时任务数据必须保存在 `runtime/` 下的项目数据路径。
- 任务触发 prompt 必须明确要求完成后只输出 `ok` 或符合既有行为。
- 定时任务不得绕过权限创建。
- 停止 Bot 时应释放 interval/cron 资源。

## Behavior

- 支持 cron 和 interval 类型任务。
- 任务触发时调用 Claude backend，并附加系统提示。
- 任务恢复时应读取 runtime 中的持久化数据。

## Error Handling

- 单个任务失败不能阻断其他任务。
- 任务执行错误应记录任务标识和安全错误摘要。
- 持久化数据损坏时应明确报错或跳过损坏任务，不能静默执行未知任务。

## Security

- 任务内容可能包含用户数据，不能提交到仓库。
- 任务创建权限必须符合权限 spec。

## Tests

修改本范围时应考虑新增 scheduler 测试，覆盖任务创建、触发、停止和错误路径。

## Acceptance Checklist

- [ ] 调度器随 Bot 生命周期释放资源。
- [ ] 任务数据留在 `runtime/`。
- [ ] 单任务失败不影响其他任务。
