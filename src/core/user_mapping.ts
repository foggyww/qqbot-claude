/** 通用用户信息映射 —— 任何插件可读写任意字段 */
import * as fs from "node:fs";
import * as path from "node:path";

let _file = "";

export function setMappingFile(filePath: string): void {
  _file = filePath;
}

function getFile(): string {
  if (_file) return _file;
  return path.join(process.cwd(), "runtime", "data", "user_mapping.json");
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
  const dir = path.dirname(getFile());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getFile(), JSON.stringify(data, null, 2), "utf-8");
}

/** 获取某个 QQ 的所有映射字段 */
export function getUserMapping(qq: number | string): Record<string, unknown> {
  const data = load();
  const key = String(qq);
  return (data.users as Record<string, Record<string, unknown>> | undefined)?.[key] ?? {};
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
