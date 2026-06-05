import { describe, expect, it } from "vitest";
import { buildCtx, stripContent, type RawMessageEvent } from "../src/core/context.js";

function groupEvent(rawMessage: string): RawMessageEvent {
  return {
    message_type: "group",
    user_id: 456,
    group_id: 789,
    self_id: 123,
    sender: { user_id: 456, nickname: "小明" },
    raw_message: rawMessage,
    message_id: 1,
    message: rawMessage,
  };
}

describe("stripContent", () => {
  it("removes only the bot mention and non-at CQ codes in group messages", () => {
    expect(
      stripContent(groupEvent("[CQ:at,qq=123]你好 [CQ:at,qq=456]小明 [CQ:image,file=1.jpg]")),
    ).toBe("你好 [CQ:at,qq=456]小明");
  });

  it("keeps private messages unchanged except for surrounding whitespace", () => {
    const event = groupEvent("unused");
    event.message_type = "private";
    event.raw_message = "  [CQ:image,file=1.jpg] hello  ";
    expect(stripContent(event)).toBe("[CQ:image,file=1.jpg] hello");
  });
});

describe("buildCtx", () => {
  it("uses explicit botNick when provided", () => {
    const ctx = buildCtx(groupEvent("hello"), { botNick: "测试机器人" });
    expect(ctx.botNick).toBe("测试机器人");
    expect(ctx.botQq).toBe(123);
    expect(ctx.sessionKey).toBe("group_789");
  });

  it("falls back to QQBot without a configured nick", () => {
    expect(buildCtx(groupEvent("hello")).botNick).toBe("QQBot");
  });
});
