// Claude Code CLI backend — implements AiBackend
// Uses child_process.spawn to run the `claude` CLI with appropriate flags.

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfig } from "../core/config.js";
import type { AiBackend } from "../core/types.js";
import { getProjectSessionId } from "../core/encode-path.js";
import { isLoopbackHost, normalizeMcpPort } from "../mcp/host.js";
import { ACCOUNTING_INVOCATION_HEADER, getAccountingRequestContext, registerAccountingInvocation } from "../core/accounting-request-context.js";
import type { AccountingRequestContext } from "../core/accounting-request-context.js";
import { cancelPendingSessionWork } from "../core/session-queue.js";

// ---------------------------------------------------------------------------
// Module-level Claude Code integration state (set by Bot.init)
// ---------------------------------------------------------------------------

let _ccPluginDirs: string[] = [];
let _mcpServerNames: string[] = ["qqbot", "qqbot-steam"];

/** Set CC native plugin directories for all subsequent AI calls */
export function setCcPluginDirs(dirs: string[]): void {
  _ccPluginDirs = dirs;
}

/** Set MCP server names for all subsequent AI calls. */
export function setMcpServerNames(names: string[]): void {
  _mcpServerNames = normalizeMcpServerNames(names);
}

// ---------------------------------------------------------------------------
// Shared spawn helper
// ---------------------------------------------------------------------------

interface RunClaudeOptions {
  msg: string;
  sessionDir: string;
  sessionId: string | null | undefined;
  systemPrompt: string | null | undefined;
  model: string | undefined;
  effort: string | undefined;
  runAsRoot: boolean;
  addDirs: string | undefined;
  ccPluginDirs?: string[];
  disableTools?: boolean;
  requestContext?: AccountingRequestContext;
}

export const MAX_CLAUDE_PROCESSES = 2;
export const MAX_CLAUDE_OUTPUT_BYTES = 2 * 1024 * 1024;
const activeProcesses = new Set<child_process.ChildProcess>();
const activeInvocations = new Set<ReturnType<typeof registerAccountingInvocation>>();
let reservedProcesses = 0;
let stopped = false;

export function startClaudeProcesses(): void {
  stopped = false;
}

function killProcessTree(proc: child_process.ChildProcess): void {
  try {
    if (process.platform === "linux" && proc.pid) process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      console.warn("[claude] failed to terminate subprocess group");
      proc.kill("SIGKILL");
    }
  }
}

/** Keep invocation credentials private while making them readable by the sudo target. */
export function prepareSudoSession(sessionDir: string, mcpConfigPath: string, uid?: number, gid?: number): void {
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid! < 0 || gid! < 0) {
    throw new Error("Claude sudo mode requires valid run.uid and run.gid (or RUN_UID/RUN_GID)");
  }
  try {
    fs.chownSync(sessionDir, uid!, gid!);
    fs.chownSync(mcpConfigPath, uid!, gid!);
    fs.chmodSync(mcpConfigPath, 0o600);
  } catch {
    throw new Error("Claude sudo mode cannot prepare private session files for the configured user");
  }
}

/** Called before stopping MCP/adapter resources, preventing orphan AI tool calls. */
export function stopClaudeProcesses(): void {
  stopped = true;
  cancelPendingSessionWork();
  for (const invocation of activeInvocations) invocation.release();
  for (const proc of activeProcesses) killProcessTree(proc);
}

export function buildToolPermissionArgs(disableTools: boolean, configuredTools: string[]): string[] {
  if (disableTools) {
    return [
      "--permission-mode", "dontAsk",
      "--tools", "",
      "--strict-mcp-config",
      "--bare",
      "--disable-slash-commands",
      "--no-session-persistence",
    ];
  }
  const allowedTools = configuredTools.length > 0
    ? configuredTools.join(",")
    : "Read,Bash,Edit,Write";
  return ["--permission-mode", "acceptEdits", "--allowedTools", allowedTools];
}

const SAFE_ONE_SHOT_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
]);

export function buildClaudeEnvironment(
  processEnv: NodeJS.ProcessEnv,
  configEnv: Record<string, string>,
  disableTools: boolean,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...processEnv };
  for (const [key, value] of Object.entries(configEnv)) {
    if (value) merged[key] = value;
  }
  if (!disableTools) return merged;

  const safe: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ONE_SHOT_ENV_KEYS) {
    if (merged[key]) safe[key] = merged[key];
  }
  safe.ANTHROPIC_API_KEY = merged.ANTHROPIC_API_KEY
    ?? merged.ANTHROPIC_AUTH_TOKEN
    ?? merged.DEEPSEEK_API_KEY;
  delete safe.ANTHROPIC_AUTH_TOKEN;
  return safe;
}

export function selectClaudeOutput(
  exitCode: number | null,
  stdoutText: string,
  _stderrText: string,
  disableTools: boolean,
  signal?: NodeJS.Signals | null,
): string {
  if (signal) throw new Error(`Claude Code terminated by signal ${signal}`);
  if (exitCode !== 0) throw new Error(`Claude Code failed with exit code ${exitCode ?? "unknown"}`);
  if (stdoutText) return stdoutText;
  if (disableTools) throw new Error("Claude one-shot returned no output");
  return "(Claude Code 无输出)";
}

export function getPreservedEnvironmentKeys(
  subprocessEnv: NodeJS.ProcessEnv,
  configEnv: Record<string, string>,
  disableTools: boolean,
): string[] {
  const source = disableTools ? subprocessEnv : configEnv;
  return Object.keys(source).filter((key) => source[key]);
}

/**
 * Low-level spawn wrapper that builds the argument list, sets up
 * the environment, and collects stdout/stderr with timeout handling.
 */
async function _runClaude(opts: RunClaudeOptions): Promise<string> {
  if (stopped) throw new Error("Bot 已停止，AI 请求已取消");
  if (reservedProcesses >= MAX_CLAUDE_PROCESSES) throw new Error("Claude Code 繁忙，请稍后再试");
  reservedProcesses++;
  const context = opts.requestContext ?? getAccountingRequestContext();
  let invocation: ReturnType<typeof registerAccountingInvocation> | undefined;
  try {
    if (context && !opts.disableTools) {
      invocation = registerAccountingInvocation(context);
      activeInvocations.add(invocation);
    }
    return await runClaudeReserved(opts, invocation?.id, () => invocation?.release());
  } finally {
    invocation?.release();
    if (invocation) activeInvocations.delete(invocation);
    reservedProcesses--;
  }
}

async function runClaudeReserved(opts: RunClaudeOptions, invocationId?: string, revokeInvocation?: () => void): Promise<string> {
  const config = getConfig();
  const model = opts.model ?? config.models[config.models.default] ?? config.models.flash;
  const sessionDir = path.resolve(opts.sessionDir);

  // Ensure session directory exists
  fs.mkdirSync(sessionDir, { recursive: true });

  const mcpConfigPath = writeMcpConfig(sessionDir, opts.disableTools ? [] : _mcpServerNames, invocationId);

  // ---- Build arguments ----
  const dirs = opts.disableTools ? [] : normalizeAddDirs(opts.addDirs || config.paths.workspaceDir);

  const claudeArgs: string[] = [
    "claude",
    "-p", opts.msg,
    ...buildToolPermissionArgs(opts.disableTools === true, config.tools),
    "--mcp-config", mcpConfigPath,
  ];
  for (const dir of dirs) {
    claudeArgs.push("--add-dir", dir);
  }

  if (opts.systemPrompt) {
    claudeArgs.push(opts.disableTools ? "--system-prompt" : "--append-system-prompt", opts.systemPrompt);
  }
  if (model) {
    claudeArgs.push("--model", model);
  }
  if (opts.effort) {
    claudeArgs.push("--effort", opts.effort);
  }
  if (opts.sessionId) {
    claudeArgs.push("--resume", opts.sessionId);
  }

  // CC native plugin dirs
  const pluginDirs = opts.ccPluginDirs ?? _ccPluginDirs;
  if (pluginDirs && pluginDirs.length > 0) {
    for (const dir of pluginDirs) {
      claudeArgs.push("--plugin-dir", dir);
    }
  }

  // ---- Build environment ----
  // Start with current process env, then overlay config.env
  const subprocessEnv = buildClaudeEnvironment(process.env, config.env, opts.disableTools === true);
  if (!subprocessEnv.CLAUDE_CONFIG_DIR) {
    subprocessEnv.CLAUDE_CONFIG_DIR = path.resolve(path.dirname(config.paths.projectsDir));
  }

  // ---- Build command (root vs chat mode) ----
  //   root mode            → run `claude ...` directly as the current user
  //   chat + useSudo=true  → run `sudo --preserve-env=... -u <run.user> claude ...`
  //   chat + useSudo=false → run `claude ...` directly as the current user
  const runUser = process.env.RUN_USER ?? config.run.user ?? os.userInfo().username;
  const runUid = process.env.RUN_UID ? Number(process.env.RUN_UID) : config.run.uid;
  const runGid = process.env.RUN_GID ? Number(process.env.RUN_GID) : config.run.gid;
  const useSudo = process.env.RUN_USE_SUDO
    ? ["1", "true", "yes", "on"].includes(process.env.RUN_USE_SUDO.toLowerCase())
    : config.run.useSudo;

  let cmd: string;
  let args: string[];

  if (opts.runAsRoot) {
    // Root mode: claude runs as the current (root) user
    cmd = "claude";
    args = claudeArgs.slice(1); // drop leading "claude"
  } else if (useSudo) {
    prepareSudoSession(sessionDir, mcpConfigPath, runUid, runGid);

    const envKeys = getPreservedEnvironmentKeys(subprocessEnv, config.env, opts.disableTools === true);
    const preserveKeys = envKeys.join(",");

    cmd = "sudo";
    args = [
      `--preserve-env=${preserveKeys}`,
      "-u", runUser,
      ...claudeArgs,
    ];
  } else {
    cmd = "claude";
    args = claudeArgs.slice(1); // drop leading "claude"
  }

  // ---- Spawn ----
  const proc = child_process.spawn(cmd, args, {
    cwd: sessionDir,
    env: subprocessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform === "linux",
  });
  activeProcesses.add(proc);

  const timeoutMs = (config.settings.timeout ?? 180) * 1000;

  // Collect output
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  // ---- Wait for completion with timeout ----
  try {
    const exit = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
      let failure: Error | undefined;
      let outputBytes = 0;
      const timer = setTimeout(() => {
        failure = new TimeoutError(`Claude Code timed out after ${timeoutMs}ms`);
        revokeInvocation?.();
        killProcessTree(proc);
      }, timeoutMs);
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        if (failure) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_CLAUDE_OUTPUT_BYTES) {
          failure = new Error("Claude Code output exceeded limit");
          revokeInvocation?.();
          killProcessTree(proc);
          return;
        }
        chunks.push(chunk);
      };
      proc.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
      proc.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
      proc.on("exit", () => killProcessTree(proc));
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({code, signal});
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        revokeInvocation?.();
        reject(err);
      });
    });

    const stdoutText = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    const stderrText = Buffer.concat(stderrChunks).toString("utf-8").trim();

    if (exit.code !== 0) {
      console.warn(`[claude] exit=${exit.code} signal=${exit.signal} stderr_len=${stderrText.length}`);
    }
    const output = selectClaudeOutput(exit.code, stdoutText, stderrText, opts.disableTools === true, exit.signal);
    console.info(`[claude] stdout_len=${output.length}`);
    return output;
  } catch (err: unknown) {
    // Ensure subprocess is killed on error
    killProcessTree(proc);

    if (err instanceof TimeoutError) {
      throw err;
    }
    throw err;
  } finally {
    activeProcesses.delete(proc);
  }
}

export function writeMcpConfig(sessionDir: string, serverNames = _mcpServerNames, invocationId?: string): string {
  const host = process.env.QQBOT_MCP_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error(`QQBOT_MCP_HOST 必须是 loopback 地址，当前为 ${host}`);
  const port = normalizeMcpPort(process.env.QQBOT_MCP_PORT ?? 8765);
  const filePath = path.resolve(sessionDir, ".qqbot-mcp.json");
  const mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }> = {};
  for (const name of normalizeMcpServerNames(serverNames)) {
    mcpServers[name] = {
      type: "http",
      url: `http://${host}:${port}/mcp/${encodeURIComponent(name)}`,
      ...(invocationId ? { headers: { [ACCOUNTING_INVOCATION_HEADER]: invocationId } } : {}),
    };
  }
  const config = {
    mcpServers,
  };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function normalizeMcpServerNames(names: string[]): string[] {
  return names
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .filter((name, index, all) => all.indexOf(name) === index);
}

function normalizeAddDirs(dirs: string): string[] {
  return dirs
    .split(/[\s,]+/)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map((dir) => path.resolve(dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);
}

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

/** Custom error class for timeout handling — mirrors Python's asyncio.TimeoutError */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Backend classes
// ---------------------------------------------------------------------------

/**
 * Normal (chat) mode backend.
 *
 * Runs claude as the current process user with only the workspace directory
 * accessible (--add-dir). Used for routine Q&A and safe operations.
 *
 * `use_sudo=true` is kept only as an advanced host-deployment compatibility
 * option; Docker deployment runs as the container's `node` user directly.
 */
class ClaudeCodeBackend implements AiBackend {
  async ask(
    msg: string,
    sessionDir: string,
    sessionId?: string | null,
    systemPrompt?: string | null,
    model?: string,
    effort?: string,
    addDirs?: string,
    ccPluginDirs?: string[],
    requestContext?: AccountingRequestContext,
  ): Promise<string> {
    return _runClaude({
      msg,
      sessionDir,
      sessionId,
      systemPrompt,
      model,
      effort,
      runAsRoot: false,
      addDirs,
      ccPluginDirs,
      requestContext,
    });
  }
}

/**
 * Root-mode backend.
 *
 * Runs claude directly as the current (root) user with both the project
 * directory and workspace directory accessible.  Grants full filesystem
 * and system control — use only for operations that require elevated
 * access.
 */
class ClaudeCodeRootBackend implements AiBackend {
  async ask(
    msg: string,
    sessionDir: string,
    sessionId?: string | null,
    systemPrompt?: string | null,
    model?: string,
    effort?: string,
    addDirs?: string,
    ccPluginDirs?: string[],
    requestContext?: AccountingRequestContext,
  ): Promise<string> {
    const config = getConfig();
    // Root mode always includes both project and workspace dirs
    const dirs = addDirs
      ? `${config.paths.projectDir},${config.paths.workspaceDir},${addDirs}`
      : `${config.paths.projectDir},${config.paths.workspaceDir}`;

    return _runClaude({
      msg,
      sessionDir,
      sessionId,
      systemPrompt,
      model,
      effort,
      runAsRoot: true,
      addDirs: dirs,
      ccPluginDirs,
      requestContext,
    });
  }
}

// ---------------------------------------------------------------------------
// Session ID management
// ---------------------------------------------------------------------------

/**
 * Derive a session ID from a session directory path.
 *
 * Mirrors the Python state.py logic: look in the projects dir for a
 * subdirectory named after the encoded session path, then find the
 * newest .jsonl file (its name minus extension is the session ID).
 */
export function getSessionId(sessionDir: string): string | null {
  const config = getConfig();
  return getProjectSessionId(sessionDir, config.paths.projectsDir);
}

// ---------------------------------------------------------------------------
// Singleton instances (lazy)
// ---------------------------------------------------------------------------

let _normal: ClaudeCodeBackend | null = null;
let _root: ClaudeCodeRootBackend | null = null;

/** Chat-mode (normal) backend singleton */
export function getClaudeCodeBackend(): ClaudeCodeBackend {
  if (!_normal) _normal = new ClaudeCodeBackend();
  return _normal;
}

/** Root-mode backend singleton */
export function getClaudeCodeRootBackend(): ClaudeCodeRootBackend {
  if (!_root) _root = new ClaudeCodeRootBackend();
  return _root;
}

// ---------------------------------------------------------------------------
// Convenience functions (mirroring Python's ask_claude / ask_claude_root)
// ---------------------------------------------------------------------------

/**
 * Shortcut: ask the normal Claude Code backend.
 */
export async function askClaude(
  msg: string,
  sessionDir: string,
  sessionId?: string | null,
  systemPrompt?: string | null,
  model?: string,
  effort?: string,
  ccPluginDirs?: string[],
  requestContext?: AccountingRequestContext,
): Promise<string> {
  return getClaudeCodeBackend().ask(msg, sessionDir, sessionId, systemPrompt, model, effort, undefined, ccPluginDirs, requestContext);
}

/** Run a one-shot text generation with built-in tools, MCP, plugins and project settings disabled. */
export async function askClaudeWithoutTools(
  msg: string,
  sessionDir: string,
  systemPrompt: string,
  model?: string,
  effort?: string,
): Promise<string> {
  return _runClaude({
    msg,
    sessionDir,
    sessionId: null,
    systemPrompt,
    model,
    effort,
    runAsRoot: false,
    addDirs: undefined,
    ccPluginDirs: [],
    disableTools: true,
  });
}

/**
 * Shortcut: ask the root-mode Claude Code backend.
 */
export async function askClaudeRoot(
  msg: string,
  sessionDir: string,
  sessionId?: string | null,
  systemPrompt?: string | null,
  model?: string,
  effort?: string,
  addDirs?: string,
  ccPluginDirs?: string[],
  requestContext?: AccountingRequestContext,
): Promise<string> {
  return getClaudeCodeRootBackend().ask(msg, sessionDir, sessionId, systemPrompt, model, effort, addDirs, ccPluginDirs, requestContext);
}

// Re-export for convenience
export { ClaudeCodeBackend, ClaudeCodeRootBackend, TimeoutError };
