/** Operations plugin set: schedule and auth. */
import type { Command, Plugin } from "../../core/types.js";
import { COMMANDS as scheduleCommands } from "./schedule.js";
import { COMMANDS as authCommands } from "./auth.js";

const COMMANDS: Command[] = [
  ...scheduleCommands,
  ...authCommands,
];

export default class OperationsBuiltinPlugin implements Plugin {
  name = "builtin-operations";
  version = "1.0.0";
  description = "内置运维命令集：schedule、auth";
  commands = COMMANDS;
}
