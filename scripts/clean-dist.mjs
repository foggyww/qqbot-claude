import * as fs from "node:fs";
import * as path from "node:path";

const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true, force: true });
}
