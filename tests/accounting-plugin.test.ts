import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountingLedger, AccountingError, formatCents, parseMoney } from "../plugins/accounting/ledger.js";
import { createAccountingMcpServer } from "../plugins/accounting/mcp-server.js";
import { handleAccountingCommand } from "../plugins/accounting/commands.js";
import type { MessageContext } from "../src/core/types.js";

let tempRoot = "";
let ledger: AccountingLedger;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-accounting-"));
  ledger = new AccountingLedger(path.join(tempRoot, "runtime", "data", "accounting"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("accounting money", () => {
  it("parses decimal money without floating point drift", () => {
    expect(parseMoney("10")).toBe(1000);
    expect(parseMoney("10.5")).toBe(1050);
    expect(parseMoney("-0.01", { allowNegative: true })).toBe(-1);
    expect(formatCents(1050)).toBe("10.50");
    expect(() => parseMoney("1.001")).toThrow(AccountingError);
    expect(() => parseMoney("1e3")).toThrow(AccountingError);
  });
});

describe("AccountingLedger", () => {
  it("keeps accounts isolated and stores original content", async () => {
    await ledger.setBalance(10001, "100.00");
    const expense = await ledger.addTransaction(10001, {
      amount: "10",
      direction: "expense",
      content: "10块，煲珠公奶茶",
    });
    await ledger.addTransaction(20002, {
      amount: "20",
      direction: "income",
      content: "收到红包20",
    });

    expect(expense.currentBalance).toBe("90.00");
    await expect(ledger.getBalance(10001)).resolves.toMatchObject({ currentBalance: "90.00" });
    await expect(ledger.getBalance(20002)).resolves.toMatchObject({ currentBalance: "20.00" });
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({
      matchedCount: 1,
      transactions: [{ content: "10块，煲珠公奶茶", amount: "10.00", direction: "expense" }],
    });
  });

  it("updates and deletes old transactions while correcting current balance", async () => {
    await ledger.setBalance(10001, "100.00");
    const created = await ledger.addTransaction(10001, {
      amount: "10",
      direction: "expense",
      content: "奶茶",
      occurredAt: "2026-08-01T12:00:00+08:00",
    });

    const updated = await ledger.updateTransaction(10001, created.transaction.id, {
      amount: "15",
      direction: "income",
      content: "退款",
    });
    expect(updated.currentBalance).toBe("115.00");
    expect(updated.transaction).toMatchObject({ amount: "15.00", direction: "income", content: "退款" });

    const deleted = await ledger.deleteTransaction(10001, created.transaction.id);
    expect(deleted.currentBalance).toBe("100.00");
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({ matchedCount: 0 });
  });

  it("filters history and reports totals before applying the result limit", async () => {
    await ledger.addTransaction(10001, { amount: "10", direction: "expense", content: "旧支出", occurredAt: "2026-07-01T12:00:00+08:00" });
    await ledger.addTransaction(10001, { amount: "20", direction: "income", content: "工资", occurredAt: "2026-08-02T12:00:00+08:00" });
    await ledger.addTransaction(10001, { amount: "5", direction: "expense", content: "奶茶", occurredAt: "2026-08-03T12:00:00+08:00" });

    const result = await ledger.listTransactions(10001, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      direction: "all",
      limit: 1,
    });

    expect(result).toMatchObject({
      matchedCount: 2,
      returnedCount: 1,
      truncated: true,
      totalIncome: "20.00",
      totalExpense: "5.00",
      netChange: "15.00",
    });
    expect(result.transactions[0]?.content).toBe("奶茶");
  });

  it("keeps virtual balance independent and calculates calendar budgets", async () => {
    await ledger.setBalance(10001, "310.00");
    await ledger.setVirtualBalance(10001, "3650.00");
    await ledger.addTransaction(10001, { amount: "10", direction: "expense", content: "支出" });

    await expect(ledger.getBalance(10001)).resolves.toMatchObject({
      currentBalance: "300.00",
      virtualBalance: "3650.00",
    });
    await expect(ledger.calculateDailyBudget(10001, {
      balanceType: "current",
      periodCount: 1,
      periodUnit: "month",
      startDate: "2026-02-01",
    })).resolves.toMatchObject({ days: 28, dailySpendable: "10.71" });
    await expect(ledger.calculateDailyBudget(10001, {
      balanceType: "virtual",
      periodCount: 1,
      periodUnit: "year",
      startDate: "2028-01-01",
    })).resolves.toMatchObject({ days: 366, availableBalance: "3650.00", dailySpendable: "9.97" });
    await expect(ledger.calculateDailyBudget(10001, {
      balanceType: "current",
      periodCount: 1,
      periodUnit: "month",
      startDate: "2026-01-31",
    })).resolves.toMatchObject({ days: 28, endDateExclusive: "2026-02-28" });
  });

  it("serializes concurrent writes for the same account", async () => {
    await ledger.setBalance(10001, "100.00");
    await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.addTransaction(10001, {
      amount: "0.10",
      direction: "expense",
      content: `支出${index}`,
    })));

    await expect(ledger.getBalance(10001)).resolves.toMatchObject({ currentBalance: "98.00" });
    await expect(ledger.listTransactions(10001, { limit: 50 })).resolves.toMatchObject({ matchedCount: 20 });
  });

  it("deduplicates concurrent retries with the same QQ message source id", async () => {
    const input = {
      amount: "10.00",
      direction: "expense" as const,
      content: "奶茶 10 元",
      sourceId: "qq-message:778899:1",
    };

    const [first, retry] = await Promise.all([
      ledger.addTransaction(10001, input),
      ledger.addTransaction(10001, input),
    ]);

    expect(first.transaction.id).toBe(retry.transaction.id);
    expect([first.deduplicated, retry.deduplicated].sort()).toEqual([false, true]);
    await expect(ledger.getBalance(10001)).resolves.toMatchObject({ currentBalance: "-10.00" });
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({ matchedCount: 1 });
  });

  it("allows identical purchases from different messages and rejects source id conflicts", async () => {
    const base = { amount: "10", direction: "expense" as const, content: "奶茶" };
    await ledger.addTransaction(10001, { ...base, sourceId: "qq-message:1:1" });
    await ledger.addTransaction(10001, { ...base, sourceId: "qq-message:2:1" });

    await expect(ledger.addTransaction(10001, {
      ...base,
      amount: "12",
      sourceId: "qq-message:1:1",
    })).rejects.toMatchObject({ code: "SOURCE_ID_CONFLICT" });
    await expect(ledger.getBalance(10001)).resolves.toMatchObject({ currentBalance: "-20.00" });
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({ matchedCount: 2 });
  });

  it("deduplicates a directly routed /账本 command when OneBot redelivers the same message", async () => {
    const ctx = {
      senderQq: 10001,
      rawEvent: { message_id: 4242 },
    } as MessageContext;

    const first = await handleAccountingCommand("支出 10 奶茶", "", ctx, ledger);
    const retry = await handleAccountingCommand("支出 10 奶茶", "", ctx, ledger);

    expect(first).toContain("当前余额：-10.00 元");
    expect(retry).toContain("当前余额：-10.00 元");
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({ matchedCount: 1 });
  });

  it("rejects positive and negative balance overflow without corrupting the account", async () => {
    await ledger.setBalance(10001, "90071992547409.91");
    await expect(ledger.addTransaction(10001, {
      amount: "0.01",
      direction: "income",
      content: "溢出收入",
    })).rejects.toMatchObject({ code: "AMOUNT_OVERFLOW" });
    await expect(ledger.getBalance(10001)).resolves.toMatchObject({ currentBalance: "90071992547409.91" });
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({ matchedCount: 0 });

    await ledger.setBalance(10001, "-90071992547409.91");
    await expect(ledger.addTransaction(10001, {
      amount: "0.01",
      direction: "expense",
      content: "溢出支出",
    })).rejects.toMatchObject({ code: "AMOUNT_OVERFLOW" });
    await expect(ledger.getBalance(10001)).resolves.toMatchObject({ currentBalance: "-90071992547409.91" });
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({ matchedCount: 0 });
  });

  it("uses private permissions under runtime data", async () => {
    await ledger.setBalance(10001, "1.00");
    const dataDir = path.join(tempRoot, "runtime", "data", "accounting");
    const accountFile = path.join(dataDir, "accounts", "10001.json");

    expect(fs.existsSync(path.join(tempRoot, "data", "accounting"))).toBe(false);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(accountFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(accountFile).mode & 0o777).toBe(0o600);
  });

  it("reports corrupted persisted timestamps and adjustments as ledger errors", async () => {
    const accountsDir = path.join(tempRoot, "runtime", "data", "accounting", "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    const base = {
      version: 1,
      ownerQq: 10001,
      currentBalanceCents: 0,
      virtualBalanceCents: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(accountsDir, "10001.json"), JSON.stringify({
      ...base,
      transactions: [{
        id: "bad-date",
        direction: "expense",
        amountCents: 100,
        content: "损坏记录",
        occurredAt: "not-a-date",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }],
      balanceAdjustments: [],
    }));

    await expect(ledger.listTransactions(10001, {})).rejects.toMatchObject({ code: "DATA_CORRUPTED" });

    fs.writeFileSync(path.join(accountsDir, "10001.json"), JSON.stringify({
      ...base,
      transactions: [],
      balanceAdjustments: [{ id: "bad-adjustment" }],
    }));
    await expect(ledger.getBalance(10001)).rejects.toMatchObject({ code: "DATA_CORRUPTED" });
  });
});

describe("accounting MCP", () => {
  it("exposes mutation, query, balance, and budget tools", async () => {
    const server = createAccountingMcpServer(ledger);
    expect(server.name).toBe("qqbot-accounting");
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "accounting_add_transaction",
      "accounting_list_transactions",
      "accounting_update_transaction",
      "accounting_delete_transaction",
      "accounting_get_balance",
      "accounting_set_balance",
      "accounting_set_virtual_balance",
      "accounting_calculate_daily_budget",
    ]);

    await expect(server.handleToolCall("accounting_add_transaction", {
      owner_qq: 10001,
      source_id: "qq-message:1:1",
      amount: "10",
      direction: "expense",
      content: "奶茶",
    })).resolves.toMatchObject({ ok: true, currentBalance: "-10.00" });
    await expect(server.handleToolCall("accounting_delete_transaction", {
      owner_qq: "10001",
      transaction_id: "bad",
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_QQ" } });
  });

  it("rejects supplied optional arguments with invalid types", async () => {
    const server = createAccountingMcpServer(ledger);
    await expect(server.handleToolCall("accounting_add_transaction", {
      owner_qq: 10001,
      source_id: "qq-message:2:1",
      amount: "10",
      direction: "expense",
      content: "奶茶",
      occurred_at: 123,
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    await expect(server.handleToolCall("accounting_list_transactions", {
      owner_qq: 10001,
      limit: "bad",
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    await expect(server.handleToolCall("accounting_update_transaction", {
      owner_qq: 10001,
      transaction_id: "id",
      content: 123,
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    await expect(server.handleToolCall("accounting_calculate_daily_budget", {
      owner_qq: 10001,
      period_count: 1,
      period_unit: "month",
      balance_type: false,
    })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("returns the original transaction when Claude retries the same add call", async () => {
    const server = createAccountingMcpServer(ledger);
    const args = {
      owner_qq: 10001,
      source_id: "qq-message:9911:1",
      amount: "18.50",
      direction: "expense",
      content: "晚饭 18.5",
    };

    const first = await server.handleToolCall("accounting_add_transaction", args);
    const retry = await server.handleToolCall("accounting_add_transaction", args);

    expect(first).toMatchObject({ ok: true, deduplicated: false, currentBalance: "-18.50" });
    expect(retry).toMatchObject({ ok: true, deduplicated: true, currentBalance: "-18.50" });
    expect((retry as { transaction: { id: string } }).transaction.id)
      .toBe((first as { transaction: { id: string } }).transaction.id);
    await expect(ledger.listTransactions(10001, {})).resolves.toMatchObject({ matchedCount: 1 });
  });
});
