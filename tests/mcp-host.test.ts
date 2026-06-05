import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMcpServerNames, writeMcpConfig } from "../src/ai/claude-code.js";
import { McpHost } from "../src/mcp/host.js";
import type { Logger, McpServer } from "../src/core/types.js";

let originalMcpHost: string | undefined;
let originalMcpPort: string | undefined;

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function server(name: string): McpServer {
  return {
    name,
    version: "1.0.0",
    tools: [],
    handleToolCall: async () => ({ ok: true }),
  };
}

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => srv.close((err) => err ? reject(err) : resolve()));
  return port;
}

afterEach(() => {
  if (originalMcpHost === undefined) delete process.env.QQBOT_MCP_HOST;
  else process.env.QQBOT_MCP_HOST = originalMcpHost;
  if (originalMcpPort === undefined) delete process.env.QQBOT_MCP_PORT;
  else process.env.QQBOT_MCP_PORT = originalMcpPort;
  setMcpServerNames(["qqbot", "qqbot-steam"]);
});

describe("Claude MCP config", () => {
  it("writes config for dynamic MCP server names", () => {
    originalMcpHost = process.env.QQBOT_MCP_HOST;
    originalMcpPort = process.env.QQBOT_MCP_PORT;
    process.env.QQBOT_MCP_HOST = "127.0.0.2";
    process.env.QQBOT_MCP_PORT = "9876";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-mcp-config-"));
    try {
      const file = writeMcpConfig(dir, ["qqbot", "qqbot-steam", "weather", "weather"]);
      const config = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        mcpServers: Record<string, { type: string; url: string }>;
      };

      expect(Object.keys(config.mcpServers)).toEqual(["qqbot", "qqbot-steam", "weather"]);
      expect(config.mcpServers.weather).toEqual({
        type: "http",
        url: "http://127.0.0.2:9876/mcp/weather",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses server names set by Bot initialization", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-mcp-config-"));
    try {
      setMcpServerNames(["qqbot", "custom-plugin"]);
      const file = writeMcpConfig(dir);
      const config = JSON.parse(fs.readFileSync(file, "utf-8")) as { mcpServers: Record<string, unknown> };

      expect(Object.keys(config.mcpServers)).toEqual(["qqbot", "custom-plugin"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("McpHost", () => {
  it("rejects duplicate MCP server names", () => {
    expect(() => new McpHost([server("dup"), server("dup")], logger())).toThrow("Duplicate MCP server name: dup");
  });

  it("serves health for unique MCP servers", async () => {
    const port = await getFreePort();
    const host = new McpHost([server("one"), server("two")], logger(), "127.0.0.1", port);
    await host.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json() as { ok: boolean; servers: string[] };

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true, servers: ["one", "two"] });
    } finally {
      await host.stop();
    }
  });

  it("rejects oversized JSON-RPC request bodies", async () => {
    const port = await getFreePort();
    const host = new McpHost([server("one")], logger(), "127.0.0.1", port);
    await host.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp/one`, {
        method: "POST",
        body: "x".repeat(1_048_577),
      });
      const body = await response.json() as { error: { message: string } };

      expect(response.status).toBe(413);
      expect(body.error.message).toContain("Request body too large");
    } finally {
      await host.stop();
    }
  });
});
