import * as fs from "node:fs";
import * as path from "node:path";

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// TypeScript compiles plugin source files, but non-TS Claude Code plugin assets
// must be copied explicitly so ccPluginDir works in built runtime.
copyDir(
  path.resolve("plugins/steam/claude-plugin"),
  path.resolve("dist/plugins/steam/claude-plugin"),
);
