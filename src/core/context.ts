import type { MessageContext, SessionStore } from "./types.js";

// ---------------------------------------------------------------------------
// Raw event type — 外部 QQ 适配器传入，结构不可控，因此用 Record 而非 any
// ---------------------------------------------------------------------------

/** QQ 适配器会传入的原始事件（最小必须字段） */
export interface RawMessageEvent {
  /** 消息类型：private | group */
  message_type: string;
  /** 发送者 QQ 号（私聊）/ 群号下的发送者（群聊） */
  user_id: number;
  /** 群号（仅群聊） */
  group_id?: number;
  /** Bot 自身 QQ 号 */
  self_id: number;
  /** 发送者信息 */
  sender: {
    user_id: number;
    nickname: string;
  };
  /** 原始消息文本（含 CQ 码） */
  raw_message: string;
  /** 消息 ID */
  message_id: number;
  /** 消息对象（OneBot 格式，适配器内部使用） */
  message: unknown;
  /** 其他扩展字段 */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/** 生成会话 key：private_xxx 或 group_xxx */
export function sessionKey(event: RawMessageEvent): string {
  if (event.message_type === "private") {
    return `private_${event.user_id}`;
  }
  if (event.message_type === "group") {
    return `group_${event.group_id ?? 0}`;
  }
  return `unknown_${event.user_id}`;
}

/** 从原始事件构建 MessageContext */
export function buildCtx(
  event: RawMessageEvent,
  opts?: { sessionStore?: SessionStore; botNick?: string },
): MessageContext {
  const replyType = event.message_type === "group" ? "group" : "private";
  const replyId =
    replyType === "group" ? (event.group_id ?? 0) : event.user_id;
  const senderNick = event.sender?.nickname ?? String(event.user_id);
  const senderQq = event.sender?.user_id ?? event.user_id;

  return {
    sessionKey: sessionKey(event),
    replyType,
    replyId,
    senderNick,
    senderQq,
    rawEvent: event,
    sessionStore: opts?.sessionStore ?? createDummySessionStore(),
    botQq: event.self_id,
    botNick: opts?.botNick ?? "QQBot",
  };
}

/** Dummy session store for contexts without the real one */
function createDummySessionStore(): SessionStore {
  return {
    loadModel: () => "",
    saveModel: () => {},
    loadEffort: () => "",
    saveEffort: () => {},
    isRootMode: () => false,
    setRootMode: () => {},
    setChatMode: () => {},
    getSessionId: () => null,
  };
}

/** 检查群聊消息是否 @了 bot */
export function isMentioned(event: RawMessageEvent): boolean {
  if (event.message_type !== "group") return false;
  const selfId = String(event.self_id);
  const raw = event.raw_message ?? "";
  return raw.includes(`[CQ:at,qq=${selfId}]`);
}

/** 去除 @bot 及非 @ CQ 码，保留 @其他人 的 CQ 码 */
export function stripContent(event: RawMessageEvent): string {
  if (event.message_type !== "group") {
    return (event.raw_message ?? "").trim();
  }
  const selfId = String(event.self_id);
  let raw = event.raw_message ?? "";

  // 移除 @bot
  raw = raw.replace(new RegExp(`\\[CQ:at,qq=${selfId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "g"), "");
  // 移除非 @ 的 CQ 码，保留 @其他人
  raw = raw.replace(/\[CQ:(?!at,)[^\]]+\]/g, "");
  return raw.trim();
}
