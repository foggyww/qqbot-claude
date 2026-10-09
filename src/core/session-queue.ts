import * as path from "node:path";

const queues = new Map<string, Promise<void>>();
const MAX_PENDING_PER_SESSION = 32;
const pendingCounts = new Map<string, number>();
let generation = 0;

/** Cancel queued commands at shutdown; a later start cannot revive old requests. */
export function cancelPendingSessionWork(): void {
  generation++;
}

/** Serialize all stateful work for a conversation, without poisoning its queue on failure. */
export async function withSessionQueue<T>(sessionDir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(sessionDir);
  const count = pendingCounts.get(key) ?? 0;
  if (count >= MAX_PENDING_PER_SESSION) throw new Error("会话繁忙，请稍后再试");
  pendingCounts.set(key, count + 1);
  const scheduledGeneration = generation;
  const previous = queues.get(key) ?? Promise.resolve();
  const running = previous.then(() => {
    if (generation !== scheduledGeneration) throw new Error("Bot 已停止，待处理请求已取消");
    return operation();
  });
  const tail = running.then(() => {}, () => {});
  queues.set(key, tail);
  try {
    return await running;
  } finally {
    const remaining = (pendingCounts.get(key) ?? 1) - 1;
    if (remaining === 0) pendingCounts.delete(key);
    else pendingCounts.set(key, remaining);
    if (queues.get(key) === tail) queues.delete(key);
  }
}
