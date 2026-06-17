/** 提示词加载 —— 运行时从 .md 文件读取 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "toml";

let _promptsDir = "";

export type PromptVariableValue = string | number | boolean | null | undefined;

export type PromptVariables = Record<string, PromptVariableValue>;

export interface ComposePromptOptions {
  preset: string;
  variables?: PromptVariables;
  includeBoundaries?: boolean;
}

interface PromptPreset {
  components: string[];
}

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

function readRequiredPromptFile(relativePath: string): string {
  const filePath = path.join(getPromptsDir(), relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${relativePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

function loadPreset(name: string): PromptPreset {
  const content = readRequiredPromptFile(path.join("presets", `${name}.toml`));
  const parsed = parseToml(content) as Record<string, unknown>;
  const components = parsed.components;
  if (!Array.isArray(components) || components.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Invalid prompt preset: ${name}`);
  }
  return { components };
}

function stringifyPromptValue(value: PromptVariableValue): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function renderPromptTemplate(template: string, variables: PromptVariables = {}): string {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replacement = stringifyPromptValue(value);
    rendered = rendered
      .replace(new RegExp(`\\{\\{\\s*${escapedKey}\\s*\\}\\}`, "g"), replacement)
      .replace(new RegExp(`\\{${escapedKey}\\}`, "g"), replacement);
  }
  return rendered;
}

export function loadPromptComponent(name: string, variables: PromptVariables = {}): string {
  const content = readRequiredPromptFile(path.join("components", `${name}.md`));
  return renderPromptTemplate(content, variables).trim();
}

export function composePrompt(options: ComposePromptOptions): string {
  const preset = loadPreset(options.preset);
  const includeBoundaries = options.includeBoundaries ?? true;

  return preset.components
    .map((componentName) => {
      const component = loadPromptComponent(componentName, options.variables);
      if (!includeBoundaries) return component;
      return `<!-- prompt: ${componentName} -->\n${component}`;
    })
    .filter((component) => component.length > 0)
    .join("\n\n");
}

export function clearPromptCache(): void {
  // Prompts are read from disk on every call, matching the Python version's hot-reload behavior.
}
