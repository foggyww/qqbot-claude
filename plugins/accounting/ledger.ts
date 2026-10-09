import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export type TransactionDirection = "income" | "expense";
export type BalanceType = "current" | "virtual";
export type PeriodUnit = "day" | "month" | "year";

interface StoredTransaction {
  id: string;
  sourceId?: string;
  direction: TransactionDirection;
  amountCents: number;
  content: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

interface BalanceAdjustment {
  id: string;
  previousBalanceCents: number;
  newBalanceCents: number;
  createdAt: string;
}

interface AccountData {
  version: 1;
  ownerQq: number;
  currentBalanceCents: number;
  virtualBalanceCents: number;
  transactions: StoredTransaction[];
  balanceAdjustments: BalanceAdjustment[];
  operations: StoredOperation[];
  createdAt: string;
  updatedAt: string;
}

interface StoredOperation {
  sourceId: string;
  kind: string;
  payload: string | null;
  result: Record<string, unknown>;
  legacy?: boolean;
}

export interface TransactionInput {
  amount: unknown;
  direction: TransactionDirection;
  content: string;
  occurredAt?: string;
  sourceId?: string;
}

export interface TransactionUpdate {
  amount?: unknown;
  direction?: TransactionDirection;
  content?: string;
  occurredAt?: string;
}

export interface ListTransactionsOptions {
  startDate?: string;
  endDate?: string;
  direction?: "all" | TransactionDirection;
  limit?: number;
}

export interface BudgetOptions {
  balanceType?: BalanceType;
  periodCount: number;
  periodUnit: PeriodUnit;
  startDate?: string;
}

export class AccountingError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountingError";
  }
}

const MONEY_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 200;
const MAX_PERIOD_COUNT = 36_500;

function safeIoCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "IO_ERROR";
}

export function parseMoney(value: unknown, options: { allowNegative?: boolean } = {}): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (text.length > 100 || !MONEY_PATTERN.test(text)) {
    throw new AccountingError("INVALID_AMOUNT", "金额必须是最多两位小数的普通数字");
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  const signed = negative ? -cents : cents;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new AccountingError("INVALID_AMOUNT", "金额超出安全范围");
  }
  const signedCents = Number(signed);
  if (!options.allowNegative && signedCents < 0) {
    throw new AccountingError("INVALID_AMOUNT", "金额不能为负数");
  }
  return signedCents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function validateOwnerQq(ownerQq: number): void {
  if (!Number.isSafeInteger(ownerQq) || ownerQq <= 0) {
    throw new AccountingError("INVALID_QQ", "owner_qq 必须是正整数 QQ 号");
  }
}

function validateDirection(direction: unknown): asserts direction is TransactionDirection {
  if (direction !== "income" && direction !== "expense") {
    throw new AccountingError("INVALID_DIRECTION", "direction 必须是 income 或 expense");
  }
}

function normalizeContent(content: unknown): string {
  if (typeof content !== "string" || content.trim() === "") {
    throw new AccountingError("MISSING_CONTENT", "记账内容不能为空");
  }
  if (content.length > 1000) {
    throw new AccountingError("CONTENT_TOO_LONG", "记账内容不能超过 1000 个字符");
  }
  return content.trim();
}

function normalizeSourceId(sourceId: unknown): string | undefined {
  if (sourceId === undefined) return undefined;
  if (typeof sourceId !== "string" || sourceId.trim() === "") {
    throw new AccountingError("INVALID_SOURCE_ID", "source_id 不能为空");
  }
  const normalized = sourceId.trim();
  if (normalized.length > 200) {
    throw new AccountingError("INVALID_SOURCE_ID", "source_id 不能超过 200 个字符");
  }
  return normalized;
}

function parseDateOnly(value: string, field: string): Date {
  if (!DATE_PATTERN.test(value)) {
    throw new AccountingError("INVALID_DATE", `${field} 必须是 YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new AccountingError("INVALID_DATE", `${field} 不是有效日期`);
  }
  return date;
}

export function shanghaiDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeOccurredAt(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string") throw new AccountingError("INVALID_DATE", "occurred_at 必须是 ISO 日期或时间");
  if (DATE_PATTERN.test(value)) {
    parseDateOnly(value, "occurred_at");
    return new Date(`${value}T00:00:00+08:00`).toISOString();
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
    (match[6] !== undefined && (Number(match[6]) > 14 || Number(match[7]) > 59 || (Number(match[6]) === 14 && Number(match[7]) !== 0)))) {
    throw new AccountingError("INVALID_DATE", "occurred_at 必须是带时区的有效完整 ISO 时间");
  }
  parseDateOnly(match[1]!, "occurred_at");
  return new Date(value).toISOString();
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(new Date(value).getTime());
}

function transactionDay(transaction: StoredTransaction): string {
  return shanghaiDate(new Date(transaction.occurredAt));
}

function addCalendarMonths(start: Date, months: number): Date {
  const target = new Date(start);
  const originalDay = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(originalDay, lastDay));
  return target;
}

function deltaCents(direction: TransactionDirection, amountCents: number): number {
  return direction === "income" ? amountCents : -amountCents;
}

function checkedCents(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new AccountingError("AMOUNT_OVERFLOW", "金额运算超出安全范围");
  }
  return Number(total);
}

function publicTransaction(transaction: StoredTransaction) {
  return {
    id: transaction.id,
    direction: transaction.direction,
    amount: formatCents(transaction.amountCents),
    delta: formatCents(deltaCents(transaction.direction, transaction.amountCents)),
    content: transaction.content,
    occurredAt: transaction.occurredAt,
    occurredDate: transactionDay(transaction),
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}

function receiptRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid receipt object");
  return value as Record<string, unknown>;
}

function receiptMoney(value: unknown): number {
  const cents = parseMoney(value, { allowNegative: true });
  if (typeof value !== "string" || formatCents(cents) !== value) throw new Error("noncanonical receipt money");
  return cents;
}

function receiptTimestamp(value: unknown): string {
  if (typeof value !== "string" || DATE_PATTERN.test(value)) throw new Error("invalid receipt timestamp");
  return normalizeOccurredAt(value);
}

function receiptKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("invalid receipt fields");
  }
}

function assertStoredOperation(operation: StoredOperation, ownerQq: number): void {
  try {
    if (operation.legacy !== undefined && operation.legacy !== true) throw new Error("invalid legacy marker");
    if (operation.legacy === true && operation.kind !== "add") throw new Error("invalid legacy kind");
    const result = receiptRecord(operation.result);
    if (result.deduplicated !== undefined && result.deduplicated !== false) throw new Error("invalid original result");
    if (operation.kind === "set_virtual") {
      receiptKeys(result, ["ok", "ownerQq", "virtualBalance"]);
      if (result.ownerQq !== ownerQq) throw new Error("receipt owner mismatch");
      const payload = receiptRecord(JSON.parse(operation.payload!));
      receiptKeys(payload, ["virtualBalanceCents"]);
      if (!Number.isSafeInteger(payload.virtualBalanceCents) || payload.virtualBalanceCents !== receiptMoney(result.virtualBalance)) throw new Error("virtual receipt mismatch");
      return;
    }
    receiptMoney(result.currentBalance);
    if (operation.kind === "set_balance") {
      receiptKeys(result, ["ok", "ownerQq", "previousBalance", "currentBalance"]);
      if (result.ownerQq !== ownerQq) throw new Error("receipt owner mismatch");
      receiptMoney(result.previousBalance);
      const payload = receiptRecord(JSON.parse(operation.payload!));
      receiptKeys(payload, ["newBalanceCents"]);
      if (!Number.isSafeInteger(payload.newBalanceCents) || payload.newBalanceCents !== receiptMoney(result.currentBalance)) throw new Error("balance receipt mismatch");
      return;
    }
    const snapshotKey = operation.kind === "delete" ? "deletedTransaction" : "transaction";
    receiptKeys(result, ["ok", snapshotKey, "currentBalance"], operation.kind === "add" ? ["deduplicated"] : []);
    const snapshot = receiptRecord(result[snapshotKey]);
    receiptKeys(snapshot, ["id", "direction", "amount", "delta", "content", "occurredAt", "occurredDate", "createdAt", "updatedAt"]);
    if (typeof snapshot.id !== "string" || !snapshot.id.trim()) throw new Error("invalid snapshot id");
    validateDirection(snapshot.direction);
    const cents = receiptMoney(snapshot.amount);
    if (cents <= 0 || receiptMoney(snapshot.delta) !== deltaCents(snapshot.direction, cents)) throw new Error("snapshot amount mismatch");
    if (normalizeContent(snapshot.content) !== snapshot.content) throw new Error("invalid snapshot content");
    const occurredAt = receiptTimestamp(snapshot.occurredAt);
    receiptTimestamp(snapshot.createdAt);
    receiptTimestamp(snapshot.updatedAt);
    if (snapshot.occurredDate !== shanghaiDate(new Date(occurredAt))) throw new Error("snapshot date mismatch");
    if (operation.payload === null) return; // Unknown original parameters for already-edited legacy entries.
    const payload = receiptRecord(JSON.parse(operation.payload));
    if (operation.kind === "delete") {
      receiptKeys(payload, ["transactionId"]);
      if (payload.transactionId !== snapshot.id) throw new Error("delete receipt mismatch");
    } else if (operation.kind === "update") {
      receiptKeys(payload, ["transactionId"], ["amountCents", "direction", "content", "occurredAt"]);
      if (payload.transactionId !== snapshot.id || Object.keys(payload).length < 2) throw new Error("update receipt mismatch");
      if ("amountCents" in payload && (!Number.isSafeInteger(payload.amountCents) || payload.amountCents !== cents)) throw new Error("update amount mismatch");
      if ("direction" in payload && payload.direction !== snapshot.direction) throw new Error("update direction mismatch");
      if ("content" in payload && payload.content !== snapshot.content) throw new Error("update content mismatch");
      if ("occurredAt" in payload && receiptTimestamp(payload.occurredAt) !== occurredAt) throw new Error("update date mismatch");
    } else {
      receiptKeys(payload, ["amountCents", "direction", "content", "occurredAt"]);
      if (!Number.isSafeInteger(payload.amountCents) || payload.amountCents !== cents || payload.direction !== snapshot.direction || payload.content !== snapshot.content ||
        (payload.occurredAt !== null && receiptTimestamp(payload.occurredAt) !== occurredAt)) throw new Error("add receipt mismatch");
    }
  } catch {
    throw new AccountingError("DATA_CORRUPTED", "账本操作凭据或结果损坏");
  }
}

function assertAccountData(value: unknown, ownerQq: number): AccountData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AccountingError("DATA_CORRUPTED", "账本数据格式损坏");
  }
  const data = value as Partial<AccountData>;
  if (
    data.version !== 1 ||
    data.ownerQq !== ownerQq ||
    !Number.isSafeInteger(data.currentBalanceCents) ||
    !Number.isSafeInteger(data.virtualBalanceCents) ||
    !Array.isArray(data.transactions) ||
    !Array.isArray(data.balanceAdjustments) ||
    !isValidTimestamp(data.createdAt) ||
    !isValidTimestamp(data.updatedAt)
  ) {
    throw new AccountingError("DATA_CORRUPTED", "账本数据格式损坏");
  }
  for (const transaction of data.transactions) {
    if (
      !transaction ||
      typeof transaction.id !== "string" ||
      (transaction.sourceId !== undefined && (typeof transaction.sourceId !== "string" || !transaction.sourceId.trim() || transaction.sourceId.length > 200)) ||
      (transaction.direction !== "income" && transaction.direction !== "expense") ||
      !Number.isSafeInteger(transaction.amountCents) ||
      transaction.amountCents <= 0 ||
      typeof transaction.content !== "string" || !transaction.content.trim() || transaction.content.length > 1000 ||
      !isValidTimestamp(transaction.occurredAt) ||
      !isValidTimestamp(transaction.createdAt) ||
      !isValidTimestamp(transaction.updatedAt)
    ) {
      throw new AccountingError("DATA_CORRUPTED", "账本流水格式损坏");
    }
  }
  for (const adjustment of data.balanceAdjustments) {
    if (
      !adjustment ||
      typeof adjustment.id !== "string" ||
      adjustment.id === "" ||
      !Number.isSafeInteger(adjustment.previousBalanceCents) ||
      !Number.isSafeInteger(adjustment.newBalanceCents) ||
      !isValidTimestamp(adjustment.createdAt)
    ) {
      throw new AccountingError("DATA_CORRUPTED", "账本余额调整记录格式损坏");
    }
  }
  if (data.operations !== undefined && !Array.isArray(data.operations)) {
    throw new AccountingError("DATA_CORRUPTED", "账本操作凭据格式损坏");
  }
  const sourceIds = new Set<string>();
  for (const operation of data.operations ?? []) {
    if (!operation || typeof operation.sourceId !== "string" || !operation.sourceId.trim() || operation.sourceId.length > 200 ||
      !["add", "update", "delete", "set_balance", "set_virtual"].includes(operation.kind) ||
      (operation.payload !== null && typeof operation.payload !== "string") ||
      (operation.payload === null && (operation.legacy !== true || operation.kind !== "add")) ||
      !operation.result || typeof operation.result !== "object" || Array.isArray(operation.result) ||
      operation.result.ok !== true || sourceIds.has(operation.sourceId)) {
      throw new AccountingError("DATA_CORRUPTED", "账本操作凭据格式损坏");
    }
    assertStoredOperation(operation, ownerQq);
    sourceIds.add(operation.sourceId);
  }
  data.operations ??= [];
  const transactionIds = new Set<string>();
  const transactionSources = new Set<string>();
  for (const transaction of data.transactions) {
    if (!transaction.id.trim() || transactionIds.has(transaction.id) ||
      (transaction.sourceId !== undefined && transactionSources.has(transaction.sourceId))) {
      throw new AccountingError("DATA_CORRUPTED", "账本流水 ID 重复或为空");
    }
    transactionIds.add(transaction.id);
    if (transaction.sourceId === undefined) continue;
    transactionSources.add(transaction.sourceId);
    if (sourceIds.has(transaction.sourceId)) {
      const original = data.operations.find((entry) => entry.sourceId === transaction.sourceId)!;
      if (original.kind !== "add" || (original.result.transaction as { id: string }).id !== transaction.id) {
        throw new AccountingError("DATA_CORRUPTED", "账本流水与新增凭据不匹配");
      }
      continue;
    }
    // Old ledgers did not preserve the original payload after editing.
    const migrated: StoredOperation = {
      sourceId: transaction.sourceId,
      kind: "add",
      legacy: true,
      payload: transaction.createdAt === transaction.updatedAt ? JSON.stringify({
        amountCents: transaction.amountCents,
        direction: transaction.direction,
        content: transaction.content,
        occurredAt: null,
      }) : null,
      result: { ok: true, transaction: publicTransaction(transaction), currentBalance: formatCents(data.currentBalanceCents!) },
    };
    assertStoredOperation(migrated, ownerQq);
    data.operations.push(migrated);
  }
  return data as AccountData;
}

export class AccountingLedger {
  private readonly writes = new Map<number, Promise<void>>();

  constructor(private readonly dataDir = path.join(process.cwd(), "runtime", "data", "accounting")) {}

  async addTransaction(ownerQq: number, input: TransactionInput) {
    validateOwnerQq(ownerQq);
    validateDirection(input.direction);
    const amountCents = parseMoney(input.amount);
    if (amountCents <= 0) throw new AccountingError("INVALID_AMOUNT", "记账金额必须大于 0");
    const content = normalizeContent(input.content);
    const occurredAt = normalizeOccurredAt(input.occurredAt);
    const sourceId = normalizeSourceId(input.sourceId);

    return this.mutate(ownerQq, (account) => {
      const timestamp = new Date().toISOString();
      const transaction: StoredTransaction = {
        id: randomUUID().replaceAll("-", ""),
        sourceId,
        direction: input.direction,
        amountCents,
        content,
        occurredAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      account.currentBalanceCents = checkedCents(
        account.currentBalanceCents,
        deltaCents(transaction.direction, transaction.amountCents),
      );
      account.transactions.push(transaction);
      return {
        ok: true as const,
        deduplicated: false,
        transaction: publicTransaction(transaction),
        currentBalance: formatCents(account.currentBalanceCents),
      };
    }, sourceId, "add", { amountCents, direction: input.direction, content, occurredAt: input.occurredAt === undefined ? null : occurredAt });
  }

  async updateTransaction(ownerQq: number, transactionId: string, update: TransactionUpdate, sourceId?: string) {
    validateOwnerQq(ownerQq);
    if (typeof transactionId !== "string" || transactionId.trim() === "") {
      throw new AccountingError("INVALID_TRANSACTION_ID", "transaction_id 不能为空");
    }
    if (update.amount === undefined && update.direction === undefined && update.content === undefined && update.occurredAt === undefined) {
      throw new AccountingError("EMPTY_UPDATE", "至少提供一个需要修改的字段");
    }
    const normalized = {
      amountCents: update.amount === undefined ? undefined : parseMoney(update.amount),
      direction: update.direction,
      content: update.content === undefined ? undefined : normalizeContent(update.content),
      occurredAt: update.occurredAt === undefined ? undefined : normalizeOccurredAt(update.occurredAt),
    };
    if (normalized.amountCents !== undefined && normalized.amountCents <= 0) throw new AccountingError("INVALID_AMOUNT", "记账金额必须大于 0");
    if (normalized.direction !== undefined) validateDirection(normalized.direction);

    return this.mutate(ownerQq, (account) => {
      const transaction = account.transactions.find((entry) => entry.id === transactionId);
      if (!transaction) throw new AccountingError("TRANSACTION_NOT_FOUND", "没有找到该记账记录");
      const oldDelta = deltaCents(transaction.direction, transaction.amountCents);
      if (update.amount !== undefined) {
        const amountCents = parseMoney(update.amount);
        if (amountCents <= 0) throw new AccountingError("INVALID_AMOUNT", "记账金额必须大于 0");
        transaction.amountCents = amountCents;
      }
      if (update.direction !== undefined) {
        validateDirection(update.direction);
        transaction.direction = update.direction;
      }
      if (update.content !== undefined) transaction.content = normalizeContent(update.content);
      if (update.occurredAt !== undefined) transaction.occurredAt = normalizeOccurredAt(update.occurredAt);
      transaction.updatedAt = new Date().toISOString();
      const newDelta = deltaCents(transaction.direction, transaction.amountCents);
      account.currentBalanceCents = checkedCents(account.currentBalanceCents, -oldDelta, newDelta);
      return {
        ok: true as const,
        transaction: publicTransaction(transaction),
        currentBalance: formatCents(account.currentBalanceCents),
      };
    }, sourceId, "update", { transactionId, ...normalized });
  }

  async deleteTransaction(ownerQq: number, transactionId: string, sourceId?: string) {
    validateOwnerQq(ownerQq);
    if (typeof transactionId !== "string" || transactionId.trim() === "") {
      throw new AccountingError("INVALID_TRANSACTION_ID", "transaction_id 不能为空");
    }
    return this.mutate(ownerQq, (account) => {
      const index = account.transactions.findIndex((entry) => entry.id === transactionId);
      if (index < 0) throw new AccountingError("TRANSACTION_NOT_FOUND", "没有找到该记账记录");
      const [transaction] = account.transactions.splice(index, 1);
      if (!transaction) throw new AccountingError("TRANSACTION_NOT_FOUND", "没有找到该记账记录");
      account.currentBalanceCents = checkedCents(
        account.currentBalanceCents,
        -deltaCents(transaction.direction, transaction.amountCents),
      );
      return {
        ok: true as const,
        deletedTransaction: publicTransaction(transaction),
        currentBalance: formatCents(account.currentBalanceCents),
      };
    }, sourceId, "delete", { transactionId });
  }

  async getBalance(ownerQq: number) {
    validateOwnerQq(ownerQq);
    const account = this.load(ownerQq);
    return {
      ok: true as const,
      ownerQq,
      currentBalance: formatCents(account.currentBalanceCents),
      virtualBalance: formatCents(account.virtualBalanceCents),
      updatedAt: account.updatedAt,
    };
  }

  async setBalance(ownerQq: number, balance: unknown, sourceId?: string) {
    validateOwnerQq(ownerQq);
    const newBalanceCents = parseMoney(balance, { allowNegative: true });
    return this.mutate(ownerQq, (account) => {
      const timestamp = new Date().toISOString();
      const previousBalanceCents = account.currentBalanceCents;
      account.currentBalanceCents = newBalanceCents;
      account.balanceAdjustments.push({
        id: randomUUID().replaceAll("-", ""),
        previousBalanceCents,
        newBalanceCents,
        createdAt: timestamp,
      });
      return {
        ok: true as const,
        ownerQq,
        previousBalance: formatCents(previousBalanceCents),
        currentBalance: formatCents(newBalanceCents),
      };
    }, sourceId, "set_balance", { newBalanceCents });
  }

  async setVirtualBalance(ownerQq: number, balance: unknown, sourceId?: string) {
    validateOwnerQq(ownerQq);
    const virtualBalanceCents = parseMoney(balance, { allowNegative: true });
    return this.mutate(ownerQq, (account) => {
      account.virtualBalanceCents = virtualBalanceCents;
      return { ok: true as const, ownerQq, virtualBalance: formatCents(virtualBalanceCents) };
    }, sourceId, "set_virtual", { virtualBalanceCents });
  }

  async listTransactions(ownerQq: number, options: ListTransactionsOptions) {
    validateOwnerQq(ownerQq);
    const direction = options.direction ?? "all";
    if (direction !== "all") validateDirection(direction);
    const startDate = options.startDate;
    const endDate = options.endDate;
    if (startDate) parseDateOnly(startDate, "start_date");
    if (endDate) parseDateOnly(endDate, "end_date");
    if (startDate && endDate && startDate > endDate) {
      throw new AccountingError("INVALID_DATE_RANGE", "结束日期不能早于开始日期");
    }
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new AccountingError("INVALID_LIMIT", `limit 必须是 1 到 ${MAX_LIMIT} 的整数`);
    }
    const account = this.load(ownerQq);
    const matched = account.transactions.filter((transaction) => {
      const day = transactionDay(transaction);
      return (!startDate || day >= startDate) && (!endDate || day <= endDate) &&
        (direction === "all" || transaction.direction === direction);
    });
    matched.sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
    let incomeCents = 0;
    let expenseCents = 0;
    for (const transaction of matched) {
      if (transaction.direction === "income") incomeCents = checkedCents(incomeCents, transaction.amountCents);
      else expenseCents = checkedCents(expenseCents, transaction.amountCents);
    }
    const transactions = matched.slice(0, limit).map(publicTransaction);
    return {
      ok: true as const,
      ownerQq,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
      direction,
      matchedCount: matched.length,
      returnedCount: transactions.length,
      truncated: matched.length > transactions.length,
      totalIncome: formatCents(incomeCents),
      totalExpense: formatCents(expenseCents),
      netChange: formatCents(checkedCents(incomeCents, -expenseCents)),
      currentBalance: formatCents(account.currentBalanceCents),
      transactions,
    };
  }

  async calculateDailyBudget(ownerQq: number, options: BudgetOptions) {
    validateOwnerQq(ownerQq);
    const balanceType = options.balanceType ?? "current";
    if (balanceType !== "current" && balanceType !== "virtual") {
      throw new AccountingError("INVALID_BALANCE_TYPE", "balance_type 必须是 current 或 virtual");
    }
    if (!Number.isSafeInteger(options.periodCount) || options.periodCount < 1 || options.periodCount > MAX_PERIOD_COUNT) {
      throw new AccountingError("INVALID_PERIOD", `period_count 必须是 1 到 ${MAX_PERIOD_COUNT} 的整数`);
    }
    if (options.periodUnit !== "day" && options.periodUnit !== "month" && options.periodUnit !== "year") {
      throw new AccountingError("INVALID_PERIOD", "period_unit 必须是 day、month 或 year");
    }
    const startDate = options.startDate ?? shanghaiDate();
    const start = parseDateOnly(startDate, "start_date");
    let end = new Date(start);
    if (options.periodUnit === "day") end.setUTCDate(end.getUTCDate() + options.periodCount);
    if (options.periodUnit === "month") end = addCalendarMonths(start, options.periodCount);
    if (options.periodUnit === "year") end = addCalendarMonths(start, options.periodCount * 12);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    const account = this.load(ownerQq);
    const availableCents = balanceType === "current" ? account.currentBalanceCents : account.virtualBalanceCents;
    const dailyCents = Math.floor(availableCents / days);
    return {
      ok: true as const,
      ownerQq,
      balanceType,
      periodCount: options.periodCount,
      periodUnit: options.periodUnit,
      startDate,
      endDateExclusive: end.toISOString().slice(0, 10),
      days,
      availableBalance: formatCents(availableCents),
      dailySpendable: formatCents(dailyCents),
    };
  }

  secureExistingData(): void {
    this.ensureDirectories();
    for (const entry of fs.readdirSync(this.accountsDir(), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        fs.chmodSync(path.join(this.accountsDir(), entry.name), 0o600);
      }
    }
  }

  private accountsDir(): string {
    return path.join(this.dataDir, "accounts");
  }

  private accountFile(ownerQq: number): string {
    return path.join(this.accountsDir(), `${ownerQq}.json`);
  }

  private ensureDirectories(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dataDir, 0o700);
    fs.mkdirSync(this.accountsDir(), { recursive: true, mode: 0o700 });
    fs.chmodSync(this.accountsDir(), 0o700);
  }

  private createAccount(ownerQq: number): AccountData {
    const timestamp = new Date().toISOString();
    return {
      version: 1,
      ownerQq,
      currentBalanceCents: 0,
      virtualBalanceCents: 0,
      transactions: [],
      balanceAdjustments: [],
      operations: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private load(ownerQq: number): AccountData {
    const file = this.accountFile(ownerQq);
    try {
      return assertAccountData(JSON.parse(fs.readFileSync(file, "utf-8")) as unknown, ownerQq);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return this.createAccount(ownerQq);
      if (error instanceof AccountingError) throw error;
      throw new AccountingError(error instanceof SyntaxError ? "DATA_CORRUPTED" : "READ_FAILED", "账本数据无法读取或解析", { cause: error });
    }
  }

  private save(ownerQq: number, account: AccountData): void {
    const file = this.accountFile(ownerQq);
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    account.updatedAt = new Date().toISOString();
    let committed = false;
    let descriptor: number | undefined;
    try {
      this.ensureDirectories();
      descriptor = fs.openSync(temporaryFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(account, null, 2)}\n`, "utf-8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryFile, file);
      committed = true;
      descriptor = fs.openSync(this.accountsDir(), "r");
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!committed) throw new AccountingError("WRITE_FAILED", "账本写入失败，未提交", { cause: error });
      console.error("[accounting] write committed, directory sync failed", safeIoCode(error));
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (error) { console.error("[accounting] close failed", safeIoCode(error)); }
      }
      if (!committed) {
        try { fs.rmSync(temporaryFile, { force: true }); } catch (error) { console.error("[accounting] temporary cleanup failed", safeIoCode(error)); }
      }
    }
  }

  private async mutate<T extends Record<string, unknown>>(ownerQq: number, operation: (account: AccountData) => T,
    sourceId?: string, kind?: string, payload?: Record<string, unknown>): Promise<T & { deduplicated: boolean }> {
    sourceId = normalizeSourceId(sourceId);
    let result: T | undefined;
    let operationError: unknown;
    const previous = this.writes.get(ownerQq) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      try {
        const account = this.load(ownerQq);
        const existing = sourceId === undefined ? undefined : account.operations.find((entry) => entry.sourceId === sourceId);
        if (existing) {
          if (existing.payload === null) throw new AccountingError("LEGACY_SOURCE_ID_UNVERIFIABLE", "旧流水已修改，无法验证原请求；已阻止重复入账");
          let expectedPayload = JSON.stringify(payload);
          if (existing.legacy && kind === "add") {
            const snapshot = existing.result.transaction as { occurredAt?: string };
            if (payload?.occurredAt !== null && payload?.occurredAt !== normalizeOccurredAt(snapshot.occurredAt)) {
              throw new AccountingError("SOURCE_ID_CONFLICT", "source_id 的发生时间与原记录不同");
            }
            expectedPayload = JSON.stringify({ ...payload, occurredAt: null });
          }
          if (existing.kind !== kind || existing.payload !== expectedPayload) {
            throw new AccountingError("SOURCE_ID_CONFLICT", "同一 source_id 已用于不同记账操作或参数");
          }
          result = { ...existing.result, deduplicated: true, currentBalance: formatCents(account.currentBalanceCents),
            ...(kind === "set_virtual" ? { virtualBalance: formatCents(account.virtualBalanceCents) } : {}) } as unknown as T;
          return;
        }
        result = operation(account);
        if (sourceId !== undefined) account.operations.push({ sourceId, kind: kind!, payload: JSON.stringify(payload), result: structuredClone(result) });
        this.save(ownerQq, account);
      } catch (error) {
        operationError = error;
      }
    });
    this.writes.set(ownerQq, current);
    await current;
    if (this.writes.get(ownerQq) === current) this.writes.delete(ownerQq);
    if (operationError) throw operationError;
    return { ...result!, deduplicated: sourceId !== undefined && (result as Record<string, unknown>)?.deduplicated === true };
  }
}
