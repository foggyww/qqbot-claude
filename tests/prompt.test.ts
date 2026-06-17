import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composePrompt,
  loadPrompt,
  loadPromptComponent,
  renderPromptTemplate,
  setPromptsDir,
} from "../src/prompt.js";

let tempRoot = "";
let originalPromptsDir: string | undefined;
const projectRoot = process.cwd();

function writePromptFile(relativePath: string, content: string): void {
  const filePath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

beforeEach(() => {
  originalPromptsDir = process.env.QQBOT_PROMPTS_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-prompts-"));
  setPromptsDir(tempRoot);
  delete process.env.QQBOT_PROMPTS_DIR;
});

afterEach(() => {
  setPromptsDir("");
  if (originalPromptsDir === undefined) delete process.env.QQBOT_PROMPTS_DIR;
  else process.env.QQBOT_PROMPTS_DIR = originalPromptsDir;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("prompt loading", () => {
  it("keeps loadPrompt compatible with flat markdown prompts", () => {
    writePromptFile("legacy.md", "hello");

    expect(loadPrompt("legacy")).toBe("hello");
    expect(loadPrompt("missing")).toBe("");
  });

  it("renders both double-brace and legacy single-brace variables", () => {
    const rendered = renderPromptTemplate("hi {{ name }}, qq={qq}, empty={{missing}}", {
      name: "Alice",
      qq: 123,
      missing: undefined,
    });

    expect(rendered).toBe("hi Alice, qq=123, empty=");
  });

  it("loads components from the components directory", () => {
    writePromptFile("components/persona/test.md", "hello {{name}}\n");

    expect(loadPromptComponent("persona/test", { name: "群友" })).toBe("hello 群友");
  });

  it("composes a preset in component order with hot reload semantics", () => {
    writePromptFile("components/identity/bot.md", "bot={{bot}}");
    writePromptFile("components/task/reply.md", "reply to {target}");
    writePromptFile(
      "presets/chat.toml",
      'components = ["identity/bot", "task/reply"]\n',
    );

    expect(composePrompt({ preset: "chat", variables: { bot: "QQBot", target: 42 } })).toContain(
      "bot=QQBot",
    );
    expect(composePrompt({ preset: "chat", variables: { bot: "QQBot", target: 42 } })).toContain(
      "reply to 42",
    );

    writePromptFile("components/task/reply.md", "updated {target}");

    expect(composePrompt({ preset: "chat", variables: { bot: "QQBot", target: 42 } })).toContain(
      "updated 42",
    );
  });

  it("throws for missing preset components", () => {
    writePromptFile("presets/broken.toml", 'components = ["missing/component"]\n');

    expect(() => composePrompt({ preset: "broken" })).toThrow(
      "Prompt file not found: components/missing/component.md",
    );
  });

  it("resolves production converse presets", () => {
    setPromptsDir(path.join(projectRoot, "prompts"));

    expect(
      composePrompt({
        preset: "converse-private",
        variables: { bot_nick: "QQBot", bot_qq: 123, master_qq: 999, reply_id: 456 },
      }),
    ).toContain("当前是私聊，对方QQ456");
    expect(
      composePrompt({
        preset: "converse-group",
        variables: { bot_nick: "QQBot", bot_qq: 123, master_qq: 999, reply_id: 789 },
      }),
    ).toContain("当前是群聊，群号789");
  });
});
