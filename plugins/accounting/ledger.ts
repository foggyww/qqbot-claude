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
  createdAt: string;
  updatedAt: string;
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
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

const MONEY_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 200;
const MAX_PERIOD_COUNT = 36_500;

export function parseMoney(value: unknown, options: { allowNegative?: boolean } = {}): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!MONEY_PATTERN.test(text)) {
    throw new AccountingError("INVALID_AMOUNT", "金额必须是最多两位小数的普通数字");
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  const signedCents = negative ? -cents : cents;
  if (!Number.isSafeInteger(signedCents)) {
    throw new AccountingError("INVALID_AMOUNT", "金额超出安全范围");
  }
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

function shanghaiDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeOccurredAt(value?: string): string {
  if (value === undefined || value === "") return new Date().toISOString();
  if (DATE_PATTERN.test(value)) {
    parseDateOnly(value, "occurred_at");
    return `${value}T00:00:00+08:00`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AccountingError("INVALID_DATE", "occurred_at 必须是有效 ISO 日期或时间");
  }
  return value;
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
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
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
      (transaction.sourceId !== undefined && (typeof transaction.sourceId !== "string" || transaction.sourceId === "")) ||
      (transaction.direction !== "income" && transaction.direction !== "expense") ||
      !Number.isSafeInteger(transaction.amountCents) ||
      transaction.amountCents <= 0 ||
      typeof transaction.content !== "string" ||
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
      if (sourceId !== undefined) {
        const existing = account.transactions.find((entry) => entry.sourceId === sourceId);
        if (existing) {
          const occurredAtConflicts = input.occurredAt !== undefined && existing.occurredAt !== occurredAt;
          if (
            existing.amountCents !== amountCents ||
            existing.direction !== input.direction ||
            existing.content !== content ||
            occurredAtConflicts
          ) {
            throw new AccountingError("SOURCE_ID_CONFLICT", "同一 source_id 已用于另一笔记账记录");
          }
          return {
            ok: true as const,
            deduplicated: true,
            transaction: publicTransaction(existing),
            currentBalance: formatCents(account.currentBalanceCents),
          };
        }
      }
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
    });
  }

  async updateTransaction(ownerQq: number, transactionId: string, update: TransactionUpdate) {
    validateOwnerQq(ownerQq);
    if (typeof transactionId !== "string" || transactionId.trim() === "") {
      throw new AccountingError("INVALID_TRANSACTION_ID", "transaction_id 不能为空");
    }
    if (update.amount === undefined && update.direction === undefined && update.content === undefined && update.occurredAt === undefined) {
      throw new AccountingError("EMPTY_UPDATE", "至少提供一个需要修改的字段");
    }

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
    });
  }

  async deleteTransaction(ownerQq: number, transactionId: string) {
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
    });
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

  async setBalance(ownerQq: number, balance: unknown) {
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
    });
  }

  async setVirtualBalance(ownerQq: number, balance: unknown) {
    validateOwnerQq(ownerQq);
    const virtualBalanceCents = parseMoney(balance, { allowNegative: true });
    return this.mutate(ownerQq, (account) => {
      account.virtualBalanceCents = virtualBalanceCents;
      return { ok: true as const, ownerQq, virtualBalance: formatCents(virtualBalanceCents) };
    });
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private load(ownerQq: number): AccountData {
    const file = this.accountFile(ownerQq);
    if (!fs.existsSync(file)) return this.createAccount(ownerQq);
    try {
      return assertAccountData(JSON.parse(fs.readFileSync(file, "utf-8")) as unknown, ownerQq);
    } catch (error) {
      if (error instanceof AccountingError) throw error;
      throw new AccountingError("DATA_CORRUPTED", "账本数据无法读取或解析");
    }
  }

  private save(ownerQq: number, account: AccountData): void {
    this.ensureDirectories();
    const file = this.accountFile(ownerQq);
    const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    account.updatedAt = new Date().toISOString();
    try {
      fs.writeFileSync(temporaryFile, `${JSON.stringify(account, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(temporaryFile, file);
      fs.chmodSync(file, 0o600);
    } catch {
      throw new AccountingError("WRITE_FAILED", "账本写入失败");
    } finally {
      fs.rmSync(temporaryFile, { force: true });
    }
  }

  private async mutate<T>(ownerQq: number, operation: (account: AccountData) => T): Promise<T> {
    let result: T | undefined;
    let operationError: unknown;
    const previous = this.writes.get(ownerQq) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      try {
        const account = this.load(ownerQq);
        result = operation(account);
        this.save(ownerQq, account);
      } catch (error) {
        operationError = error;
      }
    });
    this.writes.set(ownerQq, current);
    await current;
    if (this.writes.get(ownerQq) === current) this.writes.delete(ownerQq);
    if (operationError) throw operationError;
    return result as T;
  }
}
