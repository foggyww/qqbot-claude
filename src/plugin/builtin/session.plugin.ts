/** Session and AI mode plugin set: model, think, root. */
import type { Command, Plugin } from "../../core/types.js";
import { COMMANDS as modelCommands } from "./model.js";
import { COMMANDS as thinkCommands } from "./think.js";
import { COMMANDS as rootCommands } from "./root.js";

const COMMANDS: Command[] = [
  ...modelCommands,
  ...thinkCommands,
  ...rootCommands,
];

export default class SessionBuiltinPlugin implements Plugin {
  name = "builtin-session";
  version = "1.0.0";
  description = "内置会话与 AI 模式命令集：model、think、root";
  commands = COMMANDS;
}
