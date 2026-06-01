/**
 * /auth 指令 —— 授权管理
 *
 * 对应 Python: src/qqbot/commands/builtin/auth.py
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command, MessageContext, RoleLevel } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { findDataDir, getConfig } from "../../core/config.js";
import { LEVEL_LABELS } from "../../core/permission.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function getAuthFile(): string {
  return path.join(findDataDir(), "auth.json");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadAuth(): Record<number, number> {
  const authFile = getAuthFile();
  if (fs.existsSync(authFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(authFile, "utf-8"));
      const result: Record<number, number> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "number") {
          result[Number(k)] = v;
        }
      }
      return result;
    } catch {
      return {};
    }
  }
  return {};
}

function saveAuth(data: Record<number, number>): void {
  const authFile = getAuthFile();
  const dir = path.dirname(authFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    out[String(k)] = v;
  }
  fs.writeFileSync(authFile, JSON.stringify(out, null, 2), "utf-8");
}

function resolveLevel(qq: number): { level: number; source: string } {
  const config = getConfig();
  const authData = loadAuth();

  if (qq in config.roles) {
    return { level: config.roles[qq], source: "内置" };
  }
  if (qq in authData) {
    return { level: authData[qq], source: "授权" };
  }
  return { level: 0, source: "无" };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  msg: string,
  _sessionDir: string,
  _ctx: MessageContext,
): Promise<string> {
  const config = getConfig();
  const parts = msg.trim().split(/\s+/);
  const authData = loadAuth();

  // /auth (no args) — list all
  if (!parts[0]) {
    const lines: string[] = ["授权列表："];
    const merged = new Map<number, { level: number; source: string }>();

    // Built-in roles
    for (const [qq, lv] of Object.entries(config.roles)) {
      merged.set(Number(qq), { level: lv, source: "内置" });
    }
    // Auth file roles
    for (const [qq, lv] of Object.entries(authData)) {
      merged.set(Number(qq), { level: lv, source: "授权" });
    }

    const sorted = [...merged.entries()].sort(([a], [b]) => a - b);
    for (const [qq, info] of sorted) {
      const label = LEVEL_LABELS[info.level as RoleLevel] ?? "?";
      lines.push(`  ${qq}: level ${info.level} (${label}) [${info.source}]`);
    }
    return lines.join("\n");
  }

  // /auth <QQ> — query single user
  if (parts.length === 1) {
    const qq = Number(parts[0]);
    if (isNaN(qq)) {
      return `无效 QQ 号: ${parts[0]}`;
    }
    const info = resolveLevel(qq);
    const label = LEVEL_LABELS[info.level as RoleLevel] ?? "?";
    return `QQ ${qq}: level ${info.level} (${label}) [${info.source}]`;
  }

  // /auth <QQ> <level> — set authorization
  const qq = Number(parts[0]);
  const lv = Number(parts[1]);

  if (isNaN(qq) || isNaN(lv)) {
    return "格式: /auth <QQ号> [level]\n例如: /auth 123456 2";
  }

  if (lv < 0 || lv > 3) {
    return "level 必须是 0-3 (0=取消授权)";
  }

  const configRoles = config.roles as Record<number, number>;
  if (qq in configRoles) {
    return `QQ ${qq} 是内置角色，不能通过 /auth 修改`;
  }

  if (lv === 0) {
    delete authData[qq];
    delete configRoles[qq];
    saveAuth(authData);
    return `已取消 QQ ${qq} 的授权`;
  }

  authData[qq] = lv;
  configRoles[qq] = lv; // Immediate effect
  saveAuth(authData);
  return `已授权 QQ ${qq} 为 level ${lv} (${LEVEL_LABELS[lv as RoleLevel]})`;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "auth",
    description: "授权管理",
    prefix: "/auth",
    minLevel: 3,
    handler: handle,
  },
];

export default class AuthPlugin implements Plugin {
  name = "auth";
  version = "1.0.0";
  description = "/auth 指令 —— 授权管理";
  commands = COMMANDS;
}
