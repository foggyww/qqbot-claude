import { describe, expect, it } from "vitest";
import { authorizeAccountingWrite, getAccountingRequestContext, registerAccountingInvocation, withAccountingRequestContext, withoutAccountingRequestContext } from "../src/core/accounting-request-context.js";

describe("trusted accounting invocation", () => {
  it("binds writes to a live QQ message and revokes on completion", () => {
    const invocation = registerAccountingInvocation({ senderQq: 123, messageId: "-456" });
    try {
      expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_set_balance", { source_id: "qq-message:-456:1" }, invocation.id)).not.toThrow();
      for (const source_id of ["qq-message:457:1", "qq-message:-456:0", "qq-message:-456:101", "qq-message:-456:01", "qq-message:-456:1:2"]) {
        expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_add_transaction", { source_id }, invocation.id)).toThrow();
      }
    } finally {
      invocation.release();
    }
    expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_set_balance", { source_id: "qq-message:-456:1" }, invocation.id)).toThrow();
  });

  it("allows read-only and non-accounting tools without a message", () => {
    expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_get_balance", {})).not.toThrow();
    expect(() => authorizeAccountingWrite("qqbot", "send_message", {})).not.toThrow();
    expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_delete_transaction", { source_id: "qq-message:1:1" })).toThrow();
  });

  it("keeps concurrent QQ request metadata separate across asynchronous work", async () => {
    const contexts = await Promise.all([1, 2].map((senderQq) => withAccountingRequestContext(
      { senderQq, messageId: String(senderQq * 10) },
      async () => { await Promise.resolve(); return getAccountingRequestContext(); },
    )));
    expect(contexts).toEqual([{ senderQq: 1, messageId: "10" }, { senderQq: 2, messageId: "20" }]);
    expect(getAccountingRequestContext()).toBeUndefined();
  });

  it("can strip authority inherited by scheduled asynchronous work", async () => {
    await withAccountingRequestContext({ senderQq: 1, messageId: "10" }, async () => {
      expect(getAccountingRequestContext()).toBeDefined();
      await withoutAccountingRequestContext(async () => {
        await Promise.resolve();
        expect(getAccountingRequestContext()).toBeUndefined();
      });
      expect(getAccountingRequestContext()).toBeDefined();
    });
  });
});
