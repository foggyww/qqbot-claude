/** Workspace operation plugin set: edit and add-command. */
import type { Command, Plugin } from "../../core/types.js";
import { COMMANDS as editCommands } from "./edit.js";
import { COMMANDS as addCommandCommands } from "./add-command.js";

const COMMANDS: Command[] = [
  ...editCommands,
  ...addCommandCommands,
];

export default class WorkspaceBuiltinPlugin implements Plugin {
  name = "builtin-workspace";
  version = "1.0.0";
  description = "内置工作区操作命令集：edit、add-command";
  commands = COMMANDS;
}
