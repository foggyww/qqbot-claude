/** 通用用户信息映射 —— 任何插件可读写任意字段 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { UserMappingEntry } from "./types.js";

let _file = "";

export function setMappingFile(filePath: string): void {
  _file = filePath;
}

function getFile(): string {
  if (_file) return _file;
  return path.join(process.cwd(), "runtime", "data", "user_mapping.json");
}

export function secureUserMappingFile(filePath = getFile()): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
}

function load(): Record<string, Record<string, unknown>> {
  try {
    if (fs.existsSync(getFile())) {
      return JSON.parse(fs.readFileSync(getFile(), "utf-8"));
    }
  } catch { /* corrupt file, return empty */ }
  return {};
}

function save(data: Record<string, Record<string, unknown>>): void {
  const file = getFile();
  secureUserMappingFile(file);
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporaryFile, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
}

/** 获取某个 QQ 的所有映射字段 */
export function getUserMapping(qq: number | string): Partial<UserMappingEntry> {
  const data = load();
  const key = String(qq);
  return ((data.users as Record<string, Partial<UserMappingEntry>> | undefined)?.[key]) ?? {};
}

/** 设置某个 QQ 的某个字段 */
export function setUserField(qq: number | string, field: string, value: unknown): void {
  const data = load();
  const key = String(qq);
  if (!data.users) data.users = {} as Record<string, Record<string, unknown>>;
  if (!(data.users as Record<string, Record<string, unknown>>)[key]) {
    (data.users as Record<string, Record<string, unknown>>)[key] = {};
  }
  (data.users as Record<string, Record<string, unknown>>)[key][field] = value;
  save(data);
}

/** 获取 my_qq / my_steam_id 等顶层字段 */
export function getMyInfo(): Record<string, unknown> {
  const data = load();
  const { users: _users, ...info } = data;
  return info;
}
