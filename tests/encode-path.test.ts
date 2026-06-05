import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeProjectPath, getProjectSessionId } from "../src/core/encode-path.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-encode-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("encodeProjectPath", () => {
  it("encodes path segments into a safe directory name", () => {
    expect(encodeProjectPath("/data/sessions/group_123", "/")).toBe("-data-sessions-group-123");
  });

  it("replaces spaces and symbols", () => {
    expect(encodeProjectPath("tmp|a b|c@d", "|")).toBe("tmp-a-b-c-d");
  });
});

describe("getProjectSessionId", () => {
  it("returns null when project directory is missing", () => {
    expect(getProjectSessionId("/missing/session", tempDir())).toBeNull();
  });

  it("returns the latest jsonl file stem", () => {
    const projectsDir = tempDir();
    const sessionDir = path.join(tempDir(), "sessions", "group_1");
    const projectDir = path.join(projectsDir, encodeProjectPath(sessionDir));
    fs.mkdirSync(projectDir, { recursive: true });
    const older = path.join(projectDir, "old.jsonl");
    const newer = path.join(projectDir, "new.jsonl");
    fs.writeFileSync(older, "{}");
    fs.writeFileSync(newer, "{}");
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(2000), new Date(2000));

    expect(getProjectSessionId(sessionDir, projectsDir)).toBe("new");
  });
});
