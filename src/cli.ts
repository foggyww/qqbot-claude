#!/usr/bin/env node
import { OneBotAdapter } from "./adapter/onebot.js";
import { Bot } from "./core/bot.js";
import { loadConfig } from "./core/config.js";

async function main(): Promise<void> {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;

  const config = await loadConfig(configPath);
  const adapter = new OneBotAdapter(config.onebot.wsUrl);
  const bot = new Bot(adapter);
  await bot.init(configPath);
  await bot.runForever();
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
