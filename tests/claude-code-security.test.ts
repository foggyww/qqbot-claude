import { describe, expect, it } from "vitest";
import {
  buildClaudeEnvironment,
  buildToolPermissionArgs,
  getPreservedEnvironmentKeys,
  selectClaudeOutput,
  writeMcpConfig,
} from "../src/ai/claude-code.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("Claude one-shot security arguments", () => {
  it("disables built-in tools, MCP discovery, plugins and session persistence", () => {
    const args = buildToolPermissionArgs(true, ["Bash", "mcp__qqbot__send_message"]);

    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--bare");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args.join(" ")).not.toContain("Bash");
    expect(args.join(" ")).not.toContain("send_message");
  });

  it("maps existing auth to bare mode and removes unrelated plugin secrets", () => {
    const env = buildClaudeEnvironment(
      { PATH: "/bin", HOME: "/tmp/home", COOKIE: "private-cookie" },
      {
        ANTHROPIC_AUTH_TOKEN: "test-auth-token",
        ANTHROPIC_BASE_URL: "https://example.test/anthropic",
        STEAM_WEB_API_KEY: "test-steam-key",
      },
      true,
    );

    expect(env.ANTHROPIC_API_KEY).toBe("test-auth-token");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.test/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.STEAM_WEB_API_KEY).toBeUndefined();
    expect(env.COOKIE).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(getPreservedEnvironmentKeys(env, {}, true)).toContain("ANTHROPIC_API_KEY");
  });

  it("never returns stderr or nonzero output from a one-shot call", () => {
    expect(() => selectClaudeOutput(1, "partial output", "token=private", true)).toThrow("exit code 1");
    expect(() => selectClaudeOutput(0, "", "authorization failed", true)).toThrow("returned no output");
    expect(selectClaudeOutput(0, "safe output", "", true)).toBe("safe output");
  });

  it("writes an empty MCP configuration for no-tool calls", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-no-tools-"));
    try {
      const file = writeMcpConfig(dir, []);
      expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ mcpServers: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
