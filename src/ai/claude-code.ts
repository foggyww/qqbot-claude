// Claude Code CLI backend — implements AiBackend
// Uses child_process.spawn to run the `claude` CLI with appropriate flags.

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfig } from "../core/config.js";
import type { AiBackend } from "../core/types.js";
import { getProjectSessionId } from "../core/encode-path.js";

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
}

/**
 * Low-level spawn wrapper that builds the argument list, sets up
 * the environment, and collects stdout/stderr with timeout handling.
 */
async function _runClaude(opts: RunClaudeOptions): Promise<string> {
  const config = getConfig();
  const model = opts.model ?? config.models[config.models.default] ?? config.models.flash;
  const sessionDir = path.resolve(opts.sessionDir);

  // Ensure session directory exists
  fs.mkdirSync(sessionDir, { recursive: true });

  const mcpConfigPath = writeMcpConfig(sessionDir);

  // ---- Build arguments ----
  const dirs = normalizeAddDirs(opts.addDirs || config.paths.workspaceDir);
  const allowedTools = config.tools.length > 0
    ? config.tools.join(",")
    : "Read,Bash,Edit,Write";

  const claudeArgs: string[] = [
    "claude",
    "-p", opts.msg,
    "--permission-mode", "acceptEdits",
    "--allowedTools", allowedTools,
    "--mcp-config", mcpConfigPath,
  ];
  for (const dir of dirs) {
    claudeArgs.push("--add-dir", dir);
  }

  if (opts.systemPrompt) {
    claudeArgs.push("--append-system-prompt", opts.systemPrompt);
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
  const subprocessEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(config.env)) {
    if (v) subprocessEnv[k] = v;
  }
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
    // Chat mode with privilege drop: chown the session dir and run via sudo as the target user
    if (typeof runUid === "number" && typeof runGid === "number") {
      try {
        fs.chownSync(sessionDir, runUid, runGid);
      } catch {
        // Non-fatal — the uid/gid might not exist in test environments
      }
    }

    const envKeys = Object.keys(config.env).filter((k) => config.env[k]);
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
  });

  const timeoutMs = (config.settings.timeout ?? 180) * 1000;

  // Collect output
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // ---- Wait for completion with timeout ----
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new TimeoutError(`Claude Code timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const stdoutText = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    const stderrText = Buffer.concat(stderrChunks).toString("utf-8").trim();

    if (exitCode !== 0 && exitCode !== null) {
      const preview = stderrText.slice(0, 200);
      console.warn(`[claude] exit=${exitCode} stderr=${preview}`);
    }

    if (stdoutText) {
      const preview = stdoutText.slice(0, 120);
      console.info(`[claude] stdout_len=${stdoutText.length} preview=${preview}`);
      return stdoutText;
    }

    return stderrText || "(Claude Code 无输出)";
  } catch (err: unknown) {
    // Ensure subprocess is killed on error
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead
    }

    if (err instanceof TimeoutError) {
      throw err;
    }
    throw err;
  }
}

export function writeMcpConfig(sessionDir: string, serverNames = _mcpServerNames): string {
  const host = process.env.QQBOT_MCP_HOST ?? "127.0.0.1";
  const port = process.env.QQBOT_MCP_PORT ?? "8765";
  const filePath = path.resolve(sessionDir, ".qqbot-mcp.json");
  const mcpServers: Record<string, { type: "http"; url: string }> = {};
  for (const name of normalizeMcpServerNames(serverNames)) {
    mcpServers[name] = {
      type: "http",
      url: `http://${host}:${port}/mcp/${encodeURIComponent(name)}`,
    };
  }
  const config = {
    mcpServers,
  };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
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
): Promise<string> {
  return getClaudeCodeBackend().ask(msg, sessionDir, sessionId, systemPrompt, model, effort, undefined, ccPluginDirs);
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
): Promise<string> {
  return getClaudeCodeRootBackend().ask(msg, sessionDir, sessionId, systemPrompt, model, effort, addDirs, ccPluginDirs);
}

// Re-export for convenience
export { ClaudeCodeBackend, ClaudeCodeRootBackend, TimeoutError };
