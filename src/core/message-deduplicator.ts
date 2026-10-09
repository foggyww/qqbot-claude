/** Bounded, process-local event guard. Durable accounting receipts cover restarts. */
export class MessageDeduplicator {
  private readonly entries = new Map<string, { pending: boolean; at: number }>();

  constructor(private readonly maxEntries = 10_000, private readonly ttlMs = 24 * 60 * 60_000) {}

  begin(key: string, now = Date.now()): boolean {
    for (const [id, entry] of this.entries) {
      if (!entry.pending && now - entry.at >= this.ttlMs) this.entries.delete(id);
    }
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) {
      for (const [id, entry] of this.entries) {
        if (!entry.pending) {
          this.entries.delete(id);
          break;
        }
      }
    }
    // Do not evict in-flight events: bounded admission is safer than duplicate execution.
    if (this.entries.size >= this.maxEntries) throw new Error("消息处理队列已满，请稍后再试");
    this.entries.set(key, { pending: true, at: now });
    return true;
  }

  finish(key: string, now = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry) { entry.pending = false; entry.at = now; }
  }
}
