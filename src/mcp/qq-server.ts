/** QQ MCP Server — in-process tools backed by the project's QQAdapter. */
import type { McpServer, McpToolDefinition, QQAdapter } from "../core/types.js";
import { getMyInfo, getUserMapping } from "../core/user_mapping.js";

const TOOLS: McpToolDefinition[] = [
  {
    name: "send_message",
    description: "Send a QQ message. MUST use this for ALL QQ communication. Space messages out with sleep(2) between each send_message.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["private", "group"] },
        target: { type: "integer" },
        message: {
          type: "string",
          description: "1-3 sentences, plain text, no Markdown. To @mention a QQ user, use CQ code [CQ:at,qq=QQ号], e.g. [CQ:at,qq=123456]; do not write plain @123456.",
        },
      },
      required: ["type", "target", "message"],
    },
  },
  {
    name: "get_group_list",
    description: "List all QQ groups the bot is in",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_group_members",
    description: "Get member list of a QQ group",
    inputSchema: {
      type: "object",
      properties: { group_id: { type: "integer" } },
      required: ["group_id"],
    },
  },
  {
    name: "get_group_msg_history",
    description: "Get recent messages from a QQ group",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "integer" },
        count: { type: "integer", default: 20 },
      },
      required: ["group_id"],
    },
  },
  {
    name: "get_private_msg_history",
    description: "Get recent private chat messages",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "integer" },
        count: { type: "integer", default: 20 },
      },
      required: ["user_id"],
    },
  },
  {
    name: "get_user_info",
    description: "Get QQ user info (nickname, etc.)",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "integer" } },
      required: ["user_id"],
    },
  },
  {
    name: "delete_message",
    description: "Recall/delete a QQ message sent by the bot",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "integer" } },
      required: ["message_id"],
    },
  },
  {
    name: "get_user_mapping",
    description: "根据 QQ 号查询用户映射表，获取该用户绑定的所有第三方平台信息（Steam ID、GitHub 用户名等）",
    inputSchema: {
      type: "object",
      properties: { qq: { type: "integer", description: "QQ 号" } },
      required: ["qq"],
    },
  },
  {
    name: "get_my_info",
    description: "获取 bot 主人的信息（QQ 号、Steam ID、GitHub 等）",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "sleep",
    description: "Sleep N seconds between messages (use 2s between each send_message, max 10s)",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", minimum: 0, maximum: 10 } },
      required: ["seconds"],
    },
  },
];

export function createQqMcpServer(adapter: QQAdapter): McpServer {
  return {
    name: "qqbot",
    version: "3.0.0",
    tools: TOOLS,
    async handleToolCall(name, args) {
      switch (name) {
        case "send_message": {
          const type = String(args.type ?? "");
          const target = Number(args.target ?? 0);
          const message = String(args.message ?? "");
          if (type === "private") {
            await adapter.sendPrivateMsg(target, message);
          } else if (type === "group") {
            await adapter.sendGroupMsg(target, message);
          } else {
            throw new Error(`Invalid message type: ${type}`);
          }
          return { ok: true };
        }
        case "get_group_list": return adapter.getGroupList();
        case "get_group_members": return adapter.getGroupMembers(Number(args.group_id ?? 0));
        case "get_group_msg_history": return adapter.getGroupMsgHistory(Number(args.group_id ?? 0), Number(args.count ?? 20));
        case "get_private_msg_history": return adapter.getPrivateMsgHistory(Number(args.user_id ?? 0), Number(args.count ?? 20));
        case "get_user_info": return adapter.getStrangerInfo(Number(args.user_id ?? 0));
        case "delete_message": {
          await adapter.deleteMsg(Number(args.message_id ?? 0));
          return { ok: true };
        }
        case "sleep": {
          const seconds = Math.min(Math.max(Number(args.seconds ?? 2), 0), 10);
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
          return "slept";
        }
        case "get_user_mapping": return getUserMapping(Number(args.qq ?? 0));
        case "get_my_info": return getMyInfo();
        default: throw new Error(`Unknown tool: ${name}`);
      }
    },
  };
}

export { TOOLS as QQ_MCP_TOOLS };
