# 记账

用户要求记录收入支出、查询或设置余额、查询历史、修改或删除记账记录、设置虚拟余额、计算日预算时，使用命名空间 `mcp__qqbot-accounting__` 下的工具。

## 核心规则

- 工具是账本、余额和预算的唯一事实来源，不要根据聊天上下文自行累计或编造流水。
- 默认 `owner_qq` 使用当前消息前缀中发送者的 `qq=数字`，不要使用群号或机器人 QQ。
- 新增流水时必须把当前消息前缀中的 `message_id` 组成稳定的 `source_id`：单笔使用 `qq-message:<message_id>:1`；同一条消息包含多笔时末尾依次使用 `:1`、`:2`。重试同一次请求时必须复用相同值。
- 同一个 QQ 在私聊和群聊中使用同一本账。
- `content` 保存用户本次要求记录的原话。例如“10块，煲珠公奶茶”应完整保存为 content。
- 金额和操作不明确时先简短追问，不要猜测后执行写操作。
- 工具调用成功后只总结结果，不要重复调用写工具。

## 收入支出

- “收入、到账、工资、退款、转入、收款”等明确收入语义使用 `income`。
- 明确消费内容的“金额 + 内容”默认作为 `expense`，例如“10块，煲珠公奶茶”。
- 仅有金额且无法判断方向时先确认。
- 调用 `accounting_add_transaction` 并传入 `source_id`，回复金额、方向、原话、当前余额和简短记录 ID。

## 查询历史

- 调用 `accounting_list_transactions`。
- 今天、昨天、近一周、近 30 天、本月等转换为 Asia/Shanghai 的 `YYYY-MM-DD` 日期区间。
- 用户未指定方向时使用 `all`。
- 回复总收入、总支出、净变化，并列出时间、金额、原话和记录 ID。
- 若结果被截断，应说明只展示了部分记录。

## 修改和删除

- 修改使用 `accounting_update_transaction`，删除使用 `accounting_delete_transaction`。
- 工具必须使用精确 `transaction_id`。
- 如果用户说“删掉刚才的奶茶”“把昨天那笔 10 元改成 12 元”，先查询合适时间范围和关键词候选。
- 只有一个明确候选时可以使用其 ID 操作；有多个候选时列出候选并让用户确认，不要自行选择。
- 修改未提及的字段不要传，避免覆盖原记录。
- 删除成功后说明被删除的原记录和修正后的当前余额。

## 余额和虚拟余额

- 查询使用 `accounting_get_balance`。
- 设置当前余额使用 `accounting_set_balance`。
- 设置虚拟余额使用 `accounting_set_virtual_balance`。
- 虚拟余额独立存在，收入支出不会改变它。

## 日预算

- 使用 `accounting_calculate_daily_budget`。
- 默认 `balance_type=current`；用户明确说虚拟余额时使用 `virtual`。
- “未来 30 天”传 `period_count=30, period_unit=day`。
- “未来一个月”传 `period_count=1, period_unit=month`。
- “未来三十年”传 `period_count=30, period_unit=year`。
- 月和年由工具按实际日历天数计算，不要自行换算成 30 天或 365 天。
- 回复余额来源、可用余额、总天数和单日可支配金额。
