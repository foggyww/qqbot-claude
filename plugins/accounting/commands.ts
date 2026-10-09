import type { Command, MessageContext } from "../../src/core/types.js";
import { AccountingError, AccountingLedger, shanghaiDate } from "./ledger.js";

function errorMessage(error: unknown): string {
  return error instanceof AccountingError ? error.message : "记账操作失败";
}

function messageSourceId(ctx: MessageContext): string {
  if (!ctx.rawEvent || typeof ctx.rawEvent !== "object") throw new AccountingError("INVALID_SOURCE_ID", "缺少消息 ID，无法安全记账");
  const messageId = (ctx.rawEvent as Record<string, unknown>).message_id;
  if ((typeof messageId !== "number" && typeof messageId !== "string") || !/^-?\d+$/.test(String(messageId)) ||
    !Number.isSafeInteger(Number(messageId)) || Number(messageId) === 0) throw new AccountingError("INVALID_SOURCE_ID", "缺少有效消息 ID，无法安全记账");
  return `qq-message:${Number(messageId)}:1`;
}

export async function handleAccountingCommand(
  msg: string,
  _sessionDir: string,
  ctx: MessageContext,
  ledger = new AccountingLedger(),
): Promise<string> {
  const text = msg.trim();
  try {
    if (text === "" || text === "余额") {
      const result = await ledger.getBalance(ctx.senderQq);
      return `当前余额：${result.currentBalance} 元\n虚拟余额：${result.virtualBalance} 元`;
    }
    let match = text.match(/^设置余额\s+(.+)$/);
    if (match?.[1]) {
      const result = await ledger.setBalance(ctx.senderQq, match[1], messageSourceId(ctx));
      return result.deduplicated ? `此设置请求已处理，未重复设置\n当前余额：${result.currentBalance} 元` : `当前余额已设置为 ${result.currentBalance} 元`;
    }
    match = text.match(/^设置虚拟余额\s+(.+)$/);
    if (match?.[1]) {
      const result = await ledger.setVirtualBalance(ctx.senderQq, match[1], messageSourceId(ctx));
      return result.deduplicated ? `此设置请求已处理，未重复设置\n虚拟余额：${result.virtualBalance} 元` : `虚拟余额已设置为 ${result.virtualBalance} 元`;
    }
    match = text.match(/^(收入|支出)\s+(\S+)\s+(.+)$/);
    if (match?.[1] && match[2] && match[3]) {
      const result = await ledger.addTransaction(ctx.senderQq, {
        direction: match[1] === "收入" ? "income" : "expense",
        amount: match[2],
        content: match[3],
        sourceId: messageSourceId(ctx),
      });
      return `已记录${match[1]} ${result.transaction.amount} 元：${result.transaction.content}\n当前余额：${result.currentBalance} 元\n记录 ID：${result.transaction.id}`;
    }
    match = text.match(/^历史(?:\s+(\d+))?$/);
    if (match) {
      const days = match[1] ? Number(match[1]) : 7;
      if (!Number.isSafeInteger(days) || days < 1 || days > 36500) return "历史天数必须是 1 到 36500 的整数";
      const endDate = shanghaiDate();
      const start = new Date(`${endDate}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - days + 1);
      const result = await ledger.listTransactions(ctx.senderQq, { startDate: start.toISOString().slice(0, 10), endDate, limit: 20 });
      const rows = result.transactions.map((entry) => `${shanghaiDate(new Date(entry.occurredAt))} ${entry.direction === "income" ? "+" : "-"}${entry.amount} ${entry.content} [${entry.id}]`);
      return [`收入 ${result.totalIncome} 元，支出 ${result.totalExpense} 元，净变化 ${result.netChange} 元`, ...rows].join("\n");
    }
    return "用法：/账本 余额 | 设置余额 金额 | 设置虚拟余额 金额 | 收入 金额 内容 | 支出 金额 内容 | 历史 [天数]。自然语言修改、删除和预算可直接对机器人说。";
  } catch (error) {
    return errorMessage(error);
  }
}

export function createAccountingCommands(ledger: AccountingLedger): Command[] {
  return [{
    name: "accounting",
    description: "个人记账、余额和流水查询",
    prefix: "/账本",
    minLevel: 1,
    handler: (msg, sessionDir, ctx) => handleAccountingCommand(msg, sessionDir, ctx, ledger),
  }];
}
