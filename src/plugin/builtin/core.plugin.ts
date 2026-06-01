/** Core interaction plugin set: help, default conversation, chat mode, reset. */
import type { Command, Plugin } from "../../core/types.js";
import { COMMANDS as helpCommands } from "./help.js";
import { COMMANDS as converseCommands } from "./converse.js";
import { COMMANDS as chatCommands } from "./chat.js";
import { COMMANDS as resetCommands } from "./reset.js";

const COMMANDS: Command[] = [
  ...helpCommands,
  ...converseCommands,
  ...chatCommands,
  ...resetCommands,
];

export default class CoreBuiltinPlugin implements Plugin {
  name = "builtin-core";
  version = "1.0.0";
  description = "内置核心交互命令集：help、默认对话、chat、reset";
  commands = COMMANDS;
}
