import { cosmiconfig } from "cosmiconfig";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "toml";
import type { BotConfig, RoleLevel } from "./types.js";

// ---------------------------------------------------------------------------
// TOML loader for cosmiconfig
// ---------------------------------------------------------------------------
const tomlLoader = (_filepath: string, content: string): Record<string, unknown> => {
  return parseToml(content) as Record<string, unknown>;
};

const explorer = cosmiconfig("qqbot", {
  loaders: { ".toml": tomlLoader },
  searchPlaces: [
    ".qqbotrc.toml",
    ".qqbotrc.yaml",
    ".qqbotrc.yml",
    ".qqbotrc.json",
    ".qqbotrc",
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findDataDir(): string {
  const dir = path.join(process.cwd(), "runtime", "data");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadAuthFile(dataDir: string): Record<number, RoleLevel> {
  const authFile = path.join(dataDir, "auth.json");
  if (!fs.existsSync(authFile)) return {};

  try {
    const raw: unknown = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    const entries = raw as Record<string, unknown>;
    const result: Record<number, RoleLevel> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== "number" && typeof v !== "string") continue;
      const level = Number(v);
      if (level === 0 || level === 1 || level === 2 || level === 3) {
        result[Number(k)] = level as RoleLevel;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function safeString(
  value: unknown,
  fallback: string,
): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function safeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function safeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function requireEnv(key: string): string {
  return process.env[key] ?? "";
}

// ---------------------------------------------------------------------------
// Config cache & loader
// ---------------------------------------------------------------------------

let _config: BotConfig | null = null;

/** 加载配置（首次调用时缓存）。传 configPath 可强制指定路径。 */
export async function loadConfig(configPath?: string): Promise<BotConfig> {
  if (_config && !configPath) return _config;

  const result = configPath
    ? await explorer.load(configPath)
    : await explorer.search();

  if (!result || !result.config) {
    throw new Error(
      "未找到配置文件。请在项目根目录创建 .qqbotrc.toml",
    );
  }

  const raw = result.config as Record<string, unknown>;

  // ---- paths ----
  const paths = raw.paths as Record<string, unknown> | undefined;
  const sessionsDir = safeString(paths?.sessions_dir, path.join(process.cwd(), "runtime", "sessions"));
  const projectsDir = safeString(paths?.projects_dir, path.join(process.cwd(), "runtime", ".claude", "projects"));
  const workspaceDir = safeString(paths?.workspace_dir, path.join(process.cwd(), "runtime", "workspace"));
  const projectDir = safeString(paths?.project_dir, process.cwd());

  // ---- env ----
  const env: Record<string, string> = {};
  const rawEnv = raw.env as Record<string, unknown> | undefined;
  if (rawEnv) {
    for (const [k, v] of Object.entries(rawEnv)) {
      env[k] = String(v);
    }
  }
  // 环境变量优先级高于配置文件
  const anToken = requireEnv("ANTHROPIC_AUTH_TOKEN");
  if (anToken) env.ANTHROPIC_AUTH_TOKEN = anToken;

  // ---- run user ----
  const runRaw = raw.run as Record<string, unknown> | undefined;
  const defaultUseSudo = false;
  const runUserFromEnv = requireEnv("RUN_USER");
  const runUidFromEnv = requireEnv("RUN_UID");
  const runGidFromEnv = requireEnv("RUN_GID");
  const runUseSudoFromEnv = requireEnv("RUN_USE_SUDO");
  const configuredRunUser = safeString(runRaw?.user, "").trim();
  const runUser = runUserFromEnv || configuredRunUser || os.userInfo().username;
  const runUid = runUidFromEnv ? safeNumber(runUidFromEnv, 0) : safeNumber(runRaw?.uid, 0);
  const runGid = runGidFromEnv ? safeNumber(runGidFromEnv, 0) : safeNumber(runRaw?.gid, 0);
  const runUseSudo = runUseSudoFromEnv
    ? safeBoolean(runUseSudoFromEnv, defaultUseSudo)
    : safeBoolean(runRaw?.use_sudo ?? runRaw?.useSudo, defaultUseSudo);

  // ---- models ----
  const models = raw.models as Record<string, unknown> | undefined;
  const modelDefault = safeString(models?.default, "flash");
  const modelsMerged = {
    default: modelDefault,
    flash: safeString(models?.flash, "deepseek-v4-flash"),
    pro: safeString(models?.pro, "deepseek-v4-pro"),
  };

  // ---- efforts ----
  const efforts = raw.efforts as Record<string, unknown> | undefined;
  const effortsMerged = {
    default: safeString(efforts?.default, "high"),
  };

  // ---- settings ----
  const settings = raw.settings as Record<string, unknown> | undefined;
  const timeout = safeNumber(settings?.timeout, 180);

  // ---- roles (merged with auth.json) ----
  const roles: Record<number, RoleLevel> = {};
  const rawRoles = raw.roles as Record<string, unknown> | undefined;
  if (rawRoles) {
    for (const [k, v] of Object.entries(rawRoles)) {
      const level = Number(v);
      if (level === 0 || level === 1 || level === 2 || level === 3) {
        roles[Number(k)] = level as RoleLevel;
      }
    }
  }
  // auth.json 覆盖
  const dataDir = findDataDir();
  const authRoles = loadAuthFile(dataDir);
  Object.assign(roles, authRoles);

  // ---- group whitelist ----
  const groupWhitelist: number[] = [];
  const gw = raw.group_whitelist as Record<string, unknown> | undefined;
  if (gw && Array.isArray(gw.ids)) {
    for (const id of gw.ids) {
      if (typeof id === "number") groupWhitelist.push(id);
    }
  }

  // ---- tools ----
  const toolsRaw = (raw.tools as Record<string, unknown> | undefined)?.allowed;
  const tools: string[] = Array.isArray(toolsRaw)
    ? toolsRaw.map((t) => String(t))
    : [];

  const config: BotConfig = {
    qq: {
      account: safeNumber((raw.qq as Record<string, unknown> | undefined)?.account, 0),
      platform: (raw.qq as Record<string, unknown> | undefined)?.platform as
        | string
        | undefined,
      nickname: safeString((raw.qq as Record<string, unknown> | undefined)?.nickname, "") || undefined,
    },
    onebot: {
      wsUrl: requireEnv("ONEBOT_WS_URL") || safeString((raw.onebot as Record<string, unknown> | undefined)?.ws_url, "ws://127.0.0.1:3000"),
    },
    paths: {
      sessionsDir, projectsDir, workspaceDir, projectDir,
      rootProjectsDir: paths?.root_projects_dir as string ?? path.join(process.cwd(), "runtime", ".claude", "projects"),
    },
    env,
    run: {
      user: runUser || undefined,
      uid: runUid > 0 ? runUid : undefined,
      gid: runGid > 0 ? runGid : undefined,
      useSudo: runUseSudo,
    },
    models: modelsMerged,
    efforts: effortsMerged,
    settings: { timeout, noPermissionReply: settings?.["no_permission_reply"] as string ?? "无权限" },
    roles,
    groupWhitelist,
    tools,
    prompt: { masterQq: safeNumber((raw.prompt as Record<string, unknown> | undefined)?.master_qq as unknown, 0) },
    steamWatcher: {
      intervalMinutes: safeNumber((raw.steam_watcher as Record<string, unknown> | undefined)?.interval_minutes as unknown, 5),
    },
  };

  _config = config;
  return config;
}

/** 获取已缓存的配置（必须在 loadConfig 之后调用） */
export function getConfig(): BotConfig {
  if (!_config) {
    throw new Error("配置未加载，请先调用 loadConfig()");
  }
  return _config;
}

/**
 * 重置缓存（用于测试，或运行时切换配置）
 */
export function resetConfigCache(): void {
  _config = null;
}
