import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, chown } = vi.hoisted(() => ({ spawn: vi.fn(), chown: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  chownSync: chown,
}));
vi.mock("../src/core/config.js", () => ({
  getConfig: () => ({
    models: { default: "flash", flash: "test-model" },
    paths: { workspaceDir: "/tmp", projectsDir: "/tmp/qqbot-test/projects" },
    tools: [], env: {}, run: { useSudo: false }, settings: { timeout: 1 },
  }),
}));

import {
  askClaude, askClaudeWithoutTools, MAX_CLAUDE_OUTPUT_BYTES,
  startClaudeProcesses, stopClaudeProcesses,
  prepareSudoSession,
} from "../src/ai/claude-code.js";
import { cancelPendingSessionWork, withSessionQueue } from "../src/core/session-queue.js";
import { authorizeAccountingWrite } from "../src/core/accounting-request-context.js";

class FakeProcess extends EventEmitter {
  pid = 424242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

let dir: string;
let processes: FakeProcess[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-ai-process-"));
  processes = [];
  startClaudeProcesses();
  vi.spyOn(process, "kill").mockImplementation(() => true);
  spawn.mockImplementation(() => {
    const proc = new FakeProcess();
    processes.push(proc);
    return proc;
  });
});
afterEach(() => {
  stopClaudeProcesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawn.mockReset();
  chown.mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
});
const ask = (): Promise<string> => askClaudeWithoutTools("test", dir, "test prompt");

describe("Claude subprocess resource safety", () => {
  it.each(["timeout", "output"])("revokes invocation immediately on %s before close", async (reason) => {
    vi.useFakeTimers();
    const pending = askClaude("test", dir, null, null, undefined, undefined, undefined, { senderQq: 123, messageId: "456" });
    const check = expect(pending).rejects.toThrow(reason === "timeout" ? "timed out" : "output exceeded");
    const id = JSON.parse(fs.readFileSync(path.join(dir, ".qqbot-mcp.json"), "utf-8")).mcpServers.qqbot.headers["x-qqbot-invocation"];
    const authorize = () => authorizeAccountingWrite("qqbot-accounting", "accounting_set_balance", { user_id: 123, source_id: "qq-message:456:1" }, id);
    expect(authorize).not.toThrow();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1000);
    else processes[0].stdout.write(Buffer.alloc(MAX_CLAUDE_OUTPUT_BYTES + 1));
    expect(authorize).toThrow();
    processes[0].finish(null, "SIGKILL");
    await check;
  });

  it("prepares both sudo session directory and private MCP file ownership", () => {
    const file = path.join(dir, ".qqbot-mcp.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    prepareSudoSession(dir, file, 12345, 12346);
    expect(chown).toHaveBeenCalledWith(dir, 12345, 12346);
    expect(chown).toHaveBeenCalledWith(file, 12345, 12346);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("fails closed on absent sudo identities or ownership errors", () => {
    const file = path.join(dir, ".qqbot-mcp.json");
    expect(() => prepareSudoSession(dir, file)).toThrow("requires valid run.uid");
    expect(() => prepareSudoSession(dir, file, Number.NaN, 1)).toThrow("requires valid run.uid");
    chown.mockImplementation(() => { throw new Error("EPERM"); });
    expect(() => prepareSudoSession(dir, file, 12345, 12346)).toThrow("cannot prepare private session files");
    expect(chown).toHaveBeenCalledTimes(1);
  });

  it("revokes trusted MCP invocation metadata at completion and shutdown", async () => {
    const pending = askClaude("test", dir, null, null, undefined, undefined, undefined, { senderQq: 123, messageId: "456" });
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".qqbot-mcp.json"), "utf-8"));
    const invocationId = config.mcpServers.qqbot.headers["x-qqbot-invocation"];
    expect(typeof invocationId).toBe("string");
    expect(fs.statSync(path.join(dir, ".qqbot-mcp.json")).mode & 0o777).toBe(0o600);
    const args = { user_id: 123, source_id: "qq-message:456:1" };
    expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_set_balance", args, invocationId)).not.toThrow();
    stopClaudeProcesses();
    expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_set_balance", args, invocationId)).toThrow();
    const check = expect(pending).rejects.toThrow("signal");
    processes[0].finish(null, "SIGKILL");
    await check;
    startClaudeProcesses();
    const next = askClaude("test", dir, null, null, undefined, undefined, undefined, { senderQq: 123, messageId: "457" });
    const nextId = JSON.parse(fs.readFileSync(path.join(dir, ".qqbot-mcp.json"), "utf-8")).mcpServers.qqbot.headers["x-qqbot-invocation"];
    processes[1].stdout.write("ok");
    processes[1].finish(0);
    await next;
    expect(() => authorizeAccountingWrite("qqbot-accounting", "accounting_set_balance", { ...args, source_id: "qq-message:457:1" }, nextId)).toThrow();
  });

  it("terminates the whole Linux group on timeout and frees its slot", async () => {
    vi.useFakeTimers();
    const pending = ask();
    const check = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.kill).toHaveBeenCalledWith(-424242, "SIGKILL");
    processes[0].finish(null, "SIGKILL");
    await check;
    const next = ask();
    processes[1].stdout.write("safe");
    processes[1].finish(0);
    await expect(next).resolves.toBe("safe");
  });

  it("bounds output, including stderr, without returning partial text", async () => {
    const pending = ask();
    const check = expect(pending).rejects.toThrow("output exceeded limit");
    processes[0].stdout.write("partial");
    processes[0].stderr.write(Buffer.alloc(MAX_CLAUDE_OUTPUT_BYTES));
    processes[0].finish(null, "SIGKILL");
    await check;
    expect(process.kill).toHaveBeenCalledWith(-424242, "SIGKILL");
  });

  it("rejects overload and cancels all active groups at shutdown", async () => {
    const first = ask();
    const second = ask();
    await expect(ask()).rejects.toThrow("繁忙");
    stopClaudeProcesses();
    const checks = [expect(first).rejects.toThrow("signal"), expect(second).rejects.toThrow("signal")];
    processes.forEach(proc => proc.finish(null, "SIGKILL"));
    await Promise.all(checks);
    await expect(ask()).rejects.toThrow("已停止");
  });

  it("cleans its slot after a spawn failure", async () => {
    spawn.mockImplementationOnce(() => { throw new Error("missing cli"); });
    await expect(ask()).rejects.toThrow("missing cli");
    const pending = ask();
    processes[0].stdout.write("safe");
    processes[0].finish(0);
    await expect(pending).resolves.toBe("safe");
  });
});

describe("session queue recovery", () => {
  it("does not poison the session after failure and permits other sessions", async () => {
    const failed = withSessionQueue(dir, async () => { throw new Error("test failure"); });
    const next = withSessionQueue(dir, async () => "next");
    await expect(withSessionQueue(`${dir}/other`, async () => "other")).resolves.toBe("other");
    await expect(failed).rejects.toThrow("test failure");
    await expect(next).resolves.toBe("next");
  });

  it("does not revive queued commands after stopping and restarting", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withSessionQueue(dir, async () => gate);
    const queuedOperation = vi.fn(async () => "unexpected");
    const queued = withSessionQueue(dir, queuedOperation);
    const check = expect(queued).rejects.toThrow("已取消");
    await Promise.resolve();
    cancelPendingSessionWork();
    startClaudeProcesses();
    release();
    await first;
    await check;
    expect(queuedOperation).not.toHaveBeenCalled();
  });
});
