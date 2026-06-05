/** In-project MCP host. Starts and stops with the Bot lifecycle. */
import * as http from "node:http";
import type { Logger, McpServer } from "../core/types.js";

const MAX_BODY_SIZE_BYTES = 1_048_576;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

function makeResult(id: JsonRpcRequest["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export class McpHost {
  private server: http.Server | null = null;
  private readonly servers = new Map<string, McpServer>();

  constructor(
    servers: McpServer[],
    private readonly logger: Logger,
    private readonly host = process.env.QQBOT_MCP_HOST ?? "127.0.0.1",
    private readonly port = Number(process.env.QQBOT_MCP_PORT ?? 8765),
  ) {
    for (const server of servers) {
      if (this.servers.has(server.name)) {
        throw new Error(`Duplicate MCP server name: ${server.name}`);
      }
      this.servers.set(server.name, server);
    }
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.writeJson(res, 500, makeError(null, -32603, msg));
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });

    const names = [...this.servers.keys()].join(", ");
    this.logger.info(`MCP Host 已启动: http://${this.host}:${this.port}/mcp/<server> (${names})`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    this.logger.info("MCP Host 已停止");
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/health") {
      this.writeJson(res, 200, { ok: true, servers: [...this.servers.keys()] });
      return;
    }

    if (req.method !== "POST") {
      this.writeJson(res, 405, makeError(null, -32600, "Only POST is supported"));
      return;
    }

    const serverName = this.resolveServerName(req.url ?? "");
    const mcpServer = serverName ? this.servers.get(serverName) : undefined;
    if (!serverName || !mcpServer) {
      this.writeJson(res, 404, makeError(null, -32601, `Unknown MCP server: ${serverName ?? ""}`));
      return;
    }

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err: unknown) {
      if (err instanceof RequestBodyTooLargeError) {
        this.writeJson(res, 413, makeError(null, -32600, err.message));
        return;
      }
      throw err;
    }
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.writeJson(res, 400, makeError(null, -32700, "Parse error"));
      return;
    }

    this.writeJson(res, 200, await this.handleRpc(mcpServer, rpc));
  }

  private resolveServerName(url: string): string | null {
    const clean = url.split("?", 1)[0] ?? "";
    const match = clean.match(/^\/mcp\/([^/]+)$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  private async handleRpc(server: McpServer, req: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const method = req.method;
    const id = req.id;

    if (method === "initialize") {
      return makeResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
      });
    }

    if (method === "notifications/initialized") return null;

    if (method === "tools/list") {
      return makeResult(id, { tools: server.tools });
    }

    if (method === "tools/call") {
      const params = req.params ?? {};
      const name = String(params.name ?? "");
      const args = params.arguments ?? {};
      try {
        const result = await server.handleToolCall(name, args);
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return makeResult(id, { content: [{ type: "text", text }] });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeResult(id, { content: [{ type: "text", text: `error: ${msg}` }], isError: true });
      }
    }

    return makeError(id, -32601, `Unknown method: ${method ?? ""}`);
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += buffer.length;
      if (totalSize > MAX_BODY_SIZE_BYTES) {
        throw new RequestBodyTooLargeError(`Request body too large: limit ${MAX_BODY_SIZE_BYTES} bytes`);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body === null ? "" : JSON.stringify(body));
  }
}

class RequestBodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyTooLargeError";
  }
}
