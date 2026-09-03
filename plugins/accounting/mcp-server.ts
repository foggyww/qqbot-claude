import type { McpServer, McpToolDefinition } from "../../src/core/types.js";
import { AccountingError, AccountingLedger } from "./ledger.js";

const OWNER_QQ = { type: "integer", description: "账本所有者 QQ 号，通常取当前消息发送者 qq" };
const SOURCE_ID = { type: "string", description: "当前 QQ 消息的稳定幂等键，格式 qq-message:<message_id>:<本消息内序号>" };

const TOOLS: McpToolDefinition[] = [
  { name: "accounting_add_transaction", description: "幂等地记录一笔收入或支出；content 应保存用户原话，同一 source_id 重试不会重复入账", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ, source_id: SOURCE_ID, amount: { type: "string", description: "正数金额，最多两位小数" }, direction: { type: "string", enum: ["income", "expense"] }, content: { type: "string", description: "用户原话" }, occurred_at: { type: "string", description: "可选 ISO 日期或时间" } }, required: ["owner_qq", "source_id", "amount", "direction", "content"] } },
  { name: "accounting_list_transactions", description: "查询账本流水并返回记录 ID、汇总和当前余额，可用于定位待修改或删除记录", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ, start_date: { type: "string", description: "YYYY-MM-DD" }, end_date: { type: "string", description: "YYYY-MM-DD" }, direction: { type: "string", enum: ["all", "income", "expense"], default: "all" }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, required: ["owner_qq"] } },
  { name: "accounting_update_transaction", description: "按记录 ID 修改收入支出；会自动按差额修正当前余额", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ, transaction_id: { type: "string" }, amount: { type: "string" }, direction: { type: "string", enum: ["income", "expense"] }, content: { type: "string" }, occurred_at: { type: "string" } }, required: ["owner_qq", "transaction_id"] } },
  { name: "accounting_delete_transaction", description: "按记录 ID 删除收入支出；会自动撤销该记录对当前余额的影响", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ, transaction_id: { type: "string" } }, required: ["owner_qq", "transaction_id"] } },
  { name: "accounting_get_balance", description: "查询当前余额和独立虚拟余额", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ }, required: ["owner_qq"] } },
  { name: "accounting_set_balance", description: "直接定义当前余额；后续收入和支出在此基础上增减", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ, balance: { type: "string", description: "最多两位小数，可为负数" } }, required: ["owner_qq", "balance"] } },
  { name: "accounting_set_virtual_balance", description: "设置独立虚拟余额；普通收支不会改变它", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ, balance: { type: "string", description: "最多两位小数，可为负数" } }, required: ["owner_qq", "balance"] } },
  { name: "accounting_calculate_daily_budget", description: "使用当前或虚拟余额，按日、月或年日历周期计算单日可支配金额", inputSchema: { type: "object", properties: { owner_qq: OWNER_QQ, balance_type: { type: "string", enum: ["current", "virtual"], default: "current" }, period_count: { type: "integer", minimum: 1, maximum: 36500 }, period_unit: { type: "string", enum: ["day", "month", "year"] }, start_date: { type: "string", description: "可选 YYYY-MM-DD，默认今天（Asia/Shanghai）" } }, required: ["owner_qq", "period_count", "period_unit"] } },
];

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number") throw new AccountingError(name === "owner_qq" ? "INVALID_QQ" : "INVALID_ARGUMENT", `${name} 必须是数字`);
  return value;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new AccountingError("INVALID_ARGUMENT", `${name} 必须是字符串`);
  return value;
}

function optionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  if (!(name in args)) return undefined;
  return stringArg(args, name);
}

function optionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  if (!(name in args)) return undefined;
  return numberArg(args, name);
}

export function createAccountingMcpServer(ledger = new AccountingLedger()): McpServer {
  return {
    name: "qqbot-accounting",
    version: "1.0.0",
    tools: TOOLS,
    async handleToolCall(name, args) {
      try {
        const ownerQq = numberArg(args, "owner_qq");
        switch (name) {
          case "accounting_add_transaction":
            return await ledger.addTransaction(ownerQq, {
              amount: stringArg(args, "amount"),
              direction: stringArg(args, "direction") as "income" | "expense",
              content: stringArg(args, "content"),
              occurredAt: optionalStringArg(args, "occurred_at"),
              sourceId: stringArg(args, "source_id"),
            });
          case "accounting_list_transactions":
            return await ledger.listTransactions(ownerQq, {
              startDate: optionalStringArg(args, "start_date"),
              endDate: optionalStringArg(args, "end_date"),
              direction: optionalStringArg(args, "direction") as "all" | "income" | "expense" | undefined,
              limit: optionalNumberArg(args, "limit"),
            });
          case "accounting_update_transaction":
            return await ledger.updateTransaction(ownerQq, stringArg(args, "transaction_id"), {
              amount: optionalStringArg(args, "amount"),
              direction: optionalStringArg(args, "direction") as "income" | "expense" | undefined,
              content: optionalStringArg(args, "content"),
              occurredAt: optionalStringArg(args, "occurred_at"),
            });
          case "accounting_delete_transaction":
            return await ledger.deleteTransaction(ownerQq, stringArg(args, "transaction_id"));
          case "accounting_get_balance":
            return await ledger.getBalance(ownerQq);
          case "accounting_set_balance":
            return await ledger.setBalance(ownerQq, stringArg(args, "balance"));
          case "accounting_set_virtual_balance":
            return await ledger.setVirtualBalance(ownerQq, stringArg(args, "balance"));
          case "accounting_calculate_daily_budget":
            return await ledger.calculateDailyBudget(ownerQq, {
              balanceType: optionalStringArg(args, "balance_type") as "current" | "virtual" | undefined,
              periodCount: numberArg(args, "period_count"),
              periodUnit: stringArg(args, "period_unit") as "day" | "month" | "year",
              startDate: optionalStringArg(args, "start_date"),
            });
          default:
            throw new AccountingError("UNKNOWN_TOOL", `未知记账工具：${name}`);
        }
      } catch (error) {
        if (error instanceof AccountingError) {
          return { ok: false, error: { code: error.code, message: error.message } };
        }
        return { ok: false, error: { code: "INTERNAL_ERROR", message: "记账操作失败" } };
      }
    },
  };
}
