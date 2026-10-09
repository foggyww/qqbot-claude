import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Metadata from an actual incoming QQ event, never from model-generated text. */
export interface AccountingRequestContext {
  senderQq: number;
  messageId: string;
}

const requests = new AsyncLocalStorage<AccountingRequestContext>();
const invocations = new Map<string, AccountingRequestContext>();
export const ACCOUNTING_INVOCATION_HEADER = "x-qqbot-invocation";

const ACCOUNTING_WRITES = new Set([
  "accounting_add_transaction",
  "accounting_update_transaction",
  "accounting_delete_transaction",
  "accounting_set_balance",
  "accounting_set_virtual_balance",
]);

export function isAccountingRequestContext(value: AccountingRequestContext): boolean {
  return Number.isSafeInteger(value.senderQq) && value.senderQq > 0 &&
    /^-?\d+$/.test(value.messageId) && Number.isSafeInteger(Number(value.messageId));
}

export function withAccountingRequestContext<T>(
  context: AccountingRequestContext,
  operation: () => Promise<T>,
): Promise<T> {
  if (!isAccountingRequestContext(context)) throw new Error("Invalid QQ request metadata");
  return requests.run({ ...context, messageId: String(Number(context.messageId)) }, operation);
}

export function getAccountingRequestContext(): AccountingRequestContext | undefined {
  return requests.getStore();
}

/** Timers created while handling a QQ command must not inherit that command's write authority. */
export function withoutAccountingRequestContext<T>(operation: () => T): T {
  return requests.exit(operation);
}

/** Short-lived capability revoked on CLI completion, failure, timeout or shutdown. */
export function registerAccountingInvocation(context: AccountingRequestContext): { id: string; release(): void } {
  if (!isAccountingRequestContext(context)) throw new Error("Invalid QQ request metadata");
  const id = randomUUID();
  invocations.set(id, { ...context, messageId: String(Number(context.messageId)) });
  return { id, release: () => { invocations.delete(id); } };
}

export function clearAccountingInvocations(): void {
  invocations.clear();
}

/** Read tools retain existing trusted-user semantics; mutations require a live QQ request. */
export function authorizeAccountingWrite(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  invocationId?: string,
): void {
  if (serverName !== "qqbot-accounting" || !ACCOUNTING_WRITES.has(toolName)) return;
  const context = invocationId ? invocations.get(invocationId) : undefined;
  if (!context) throw new Error("记账写操作缺少有效的 QQ 消息上下文，请从 QQ 重新发起请求");
  const prefix = `qq-message:${context.messageId}:`;
  const sourceId = args.source_id;
  if (typeof sourceId !== "string" || !sourceId.startsWith(prefix)) {
    throw new Error("source_id 必须来自当前 QQ 消息，不能更换消息编号重试");
  }
  const index = sourceId.slice(prefix.length);
  if (!/^[1-9]\d{0,2}$/.test(index) || Number(index) > 100) {
    throw new Error("source_id 的操作序号必须是 1 到 100 的整数");
  }
}
