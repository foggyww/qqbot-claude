import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Encode a filesystem path into the directory name used by Claude Code's
 * projects storage.
 */
export function encodeProjectPath(p: string, sep = path.sep): string {
  return p.split(sep).map((s) => s.replace(/[^a-zA-Z0-9]/g, "-")).join("-");
}

/**
 * Look up the latest Claude Code JSONL session id for a session directory.
 */
export function getProjectSessionId(
  sessionDir: string,
  projectsDir: string,
): string | null {
  const projectDir = path.join(projectsDir, encodeProjectPath(sessionDir));
  if (!fs.existsSync(projectDir)) return null;

  let files: string[];
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const latest = files.reduce((a, b) => {
    const aStat = fs.statSync(path.join(projectDir, a));
    const bStat = fs.statSync(path.join(projectDir, b));
    return aStat.mtimeMs > bStat.mtimeMs ? a : b;
  });

  return latest.replace(/\.jsonl$/, "");
}
