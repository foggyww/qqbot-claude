import { describe, expect, it } from "vitest";

import { formatOneBotApiError } from "../src/adapter/onebot.js";

describe("formatOneBotApiError", () => {
  it.each([
    ["msg", { retcode: 1200, msg: "请求失败" }, "OneBot API error: retcode=1200: 请求失败"],
    ["wording", { retcode: 1200, wording: "网络连接异常" }, "OneBot API error: retcode=1200: 网络连接异常"],
    ["message", { retcode: 1200, message: "账号已离线" }, "OneBot API error: retcode=1200: 账号已离线"],
  ])("includes a non-empty %s diagnostic", (_field, response, expected) => {
    expect(formatOneBotApiError(response)).toBe(expected);
  });

  it("ignores empty diagnostics and always includes retcode", () => {
    expect(formatOneBotApiError({ retcode: 1200, msg: " ", wording: "" }))
      .toBe("OneBot API error: retcode=1200");
  });

  it("keeps distinct diagnostics and removes duplicates", () => {
    expect(formatOneBotApiError({
      retcode: 1200,
      msg: "failed",
      wording: "网络连接异常",
      message: "网络连接异常",
    })).toBe("OneBot API error: retcode=1200: failed; 网络连接异常");
  });
});
