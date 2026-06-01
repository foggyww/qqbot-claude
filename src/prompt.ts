/** 提示词加载 —— 运行时从 .md 文件读取 */
import * as fs from "node:fs";
import * as path from "node:path";

let _promptsDir = "";

export function setPromptsDir(dir: string): void {
  _promptsDir = dir;
}

function getPromptsDir(): string {
  if (_promptsDir) return _promptsDir;
  // 默认：项目根目录下的 prompts/
  const cwd = process.env.QQBOT_PROMPTS_DIR ?? path.join(process.cwd(), "prompts");
  return cwd;
}

export function loadPrompt(name: string): string {
  const filePath = path.join(getPromptsDir(), `${name}.md`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8");
  }
  return "";
}

export function clearPromptCache(): void {
  // Prompts are read from disk on every call, matching the Python version's hot-reload behavior.
}
