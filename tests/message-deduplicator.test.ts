import { describe, expect, it } from "vitest";
import { MessageDeduplicator } from "../src/core/message-deduplicator.js";

describe("incoming message admission", () => {
  it("rejects in-flight and completed duplicates while accepting distinct events", () => {
    const guard = new MessageDeduplicator(3, 100);
    expect(guard.begin("a", 0)).toBe(true);
    expect(guard.begin("a", 1)).toBe(false);
    guard.finish("a", 2);
    expect(guard.begin("a", 3)).toBe(false);
    expect(guard.begin("b", 3)).toBe(true);
    expect(guard.begin("a", 103)).toBe(true);
  });

  it("never evicts pending messages to admit more work", () => {
    const guard = new MessageDeduplicator(2);
    guard.begin("a"); guard.begin("b");
    expect(() => guard.begin("c")).toThrow("队列已满");
    expect(guard.begin("a")).toBe(false);
    guard.finish("b");
    expect(guard.begin("c")).toBe(true);
    expect(guard.begin("a")).toBe(false);
  });
});
