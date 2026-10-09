#!/usr/bin/env node
/* global process, setInterval */
// Disposable integration fixture; inherits the parent's process group.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[process.argv.indexOf("-p") + 1], String(child.pid));
setInterval(() => {}, 1000);
