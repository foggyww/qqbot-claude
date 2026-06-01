#!/usr/bin/env node
import { OneBotAdapter } from "./adapter/onebot.js";
import { Bot } from "./core/bot.js";

async function main(): Promise<void> {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;

  const adapter = new OneBotAdapter();
  const bot = new Bot(adapter);
  await bot.init(configPath);
  await bot.runForever();
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
