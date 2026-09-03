import type { BotContext, Command, McpServer, Plugin } from "../../src/core/types.js";
import { createAccountingCommands } from "./commands.js";
import { AccountingLedger } from "./ledger.js";
import { createAccountingMcpServer } from "./mcp-server.js";

export class AccountingPlugin implements Plugin {
  name = "accounting";
  version = "1.0.0";
  description = "按 QQ 隔离的个人记账、余额、流水编辑和日预算";
  ccPluginDir = "claude-plugin";
  private readonly ledger = new AccountingLedger();
  commands: Command[] = createAccountingCommands(this.ledger);
  mcpServers: McpServer[] = [createAccountingMcpServer(this.ledger)];

  async onLoad(_ctx: BotContext): Promise<void> {
    this.ledger.secureExistingData();
  }
}

export default AccountingPlugin;
