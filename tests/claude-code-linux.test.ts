import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/config.js", () => ({
  getConfig: () => ({
    models: { default: "flash", flash: "test-model" },
    paths: { workspaceDir: "/tmp", projectsDir: "/tmp/qqbot-linux-test/projects" },
    tools: [], env: {}, run: { useSudo: false }, settings: { timeout: 1 },
  }),
}));
import { askClaudeWithoutTools, startClaudeProcesses, stopClaudeProcesses } from "../src/ai/claude-code.js";

describe.skipIf(process.platform !== "linux")("actual Linux subprocess groups", () => {
  it("kills a real descendant after the fake CLI exceeds its deadline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-linux-process-"));
    const originalPath = process.env.PATH;
    const pidFile = path.join(dir, "child.pid");
    let childPid: number | undefined;
    try {
      fs.copyFileSync(new URL("./fixtures/fake-claude.mjs", import.meta.url), path.join(dir, "claude"));
      fs.chmodSync(path.join(dir, "claude"), 0o700);
      process.env.PATH = `${dir}:${originalPath ?? "/usr/bin:/bin"}`;
      startClaudeProcesses();
      await expect(askClaudeWithoutTools(pidFile, dir, "test")).rejects.toMatchObject({ name: "TimeoutError" });
      childPid = Number(fs.readFileSync(pidFile, "utf-8"));
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      let alive = true;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const status = fs.readFileSync(`/proc/${childPid}/status`, "utf-8");
          alive = !/^State:\s+Z/m.test(status);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          alive = false;
        }
        if (!alive) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(alive).toBe(false);
    } finally {
      stopClaudeProcesses();
      // Only this test's validated child PID; never target an unrelated process/group.
      if (childPid && Number.isSafeInteger(childPid) && childPid > 0) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already terminated */ }
      }
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
