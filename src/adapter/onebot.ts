// OneBot v11 WebSocket adapter — implements QQAdapter
// Connects to NapCat OneBot WebSocket at ws://127.0.0.1:3000 by default.

import { buildCtx } from "../core/context.js";
import type { RawMessageEvent } from "../core/context.js";
import type {
  MessageContext,
  QQAdapter,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default NapCat OneBot WebSocket URL */
const DEFAULT_WS_URL = "ws://127.0.0.1:3000";

/** Max reconnect delay (ms) */
const MAX_RECONNECT_MS = 30_000;

/** Initial reconnect delay (ms) */
const INITIAL_RECONNECT_MS = 1_000;

/** API call timeout (ms) — must complete within this window */
const API_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integerId(value: unknown, positive: boolean): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && (!positive || n > 0) ? n : null;
}

// ---------------------------------------------------------------------------
// Message segment → CQ-code conversion
// ---------------------------------------------------------------------------

/**
 * Convert a OneBot v11 message segment to its CQ-code string form.
 * Used as fallback when an event lacks a `raw_message` field.
 */
function segmentToCqCode(seg: Record<string, unknown>): string {
  if (typeof seg.type !== "string" || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(seg.type)) return "";
  const segType = seg.type;
  const data = isRecord(seg.data) ? seg.data : undefined;

  if (segType === "text") {
    return typeof data?.text === "string" ? data.text : "";
  }

  const params: string[] = [];
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") {
        params.push(`${k}=${escapeCqValue(v)}`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        params.push(`${k}=${String(v)}`);
      }
    }
  }
  return `[CQ:${segType}${params.length > 0 ? "," + params.join(",") : ""}]`;
}

/** Escape special characters inside CQ-code values */
function escapeCqValue(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

/**
 * Build a `raw_message`-style string from a OneBot v11 message segment array.
 */
function segmentsToRawMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message.filter(isRecord).map(segmentToCqCode).join("");
}

/**
 * Convert the common AI mistake of writing plain `@123456` into a OneBot CQ at
 * segment. Existing CQ codes are left untouched. This is only a safety net; the
 * prompts and MCP tool schema also teach Claude to emit CQ codes directly.
 */
function normalizeOutgoingMessage(message: string): string {
  return message.replace(/(^|[^\w[\]])@(\d{6,12})(?=\b|\s|$)/g, (_m, prefix: string, qq: string) => {
    return `${prefix}[CQ:at,qq=${qq}]`;
  });
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

/**
 * Map a OneBot v11 event JSON object into a RawMessageEvent.
 * OneBot fields used:
 *   post_type, message_type, user_id, group_id, self_id,
 *   sender.user_id, sender.nickname, sender.card,
 *   raw_message, message, message_id
 */
function parseOneBotEvent(raw: Record<string, unknown>): RawMessageEvent | null {
  // Only handle message events
  if (raw.post_type !== "message") return null;

  const msgType = raw.message_type;
  if (msgType !== "private" && msgType !== "group") return null;

  const userId = integerId(raw.user_id, true);
  const selfId = integerId(raw.self_id, true);
  const groupId = msgType === "group" ? integerId(raw.group_id, true) : undefined;
  const messageId = integerId(raw.message_id, false);
  if (userId === null || selfId === null || groupId === null || messageId === null) return null;

  const senderObj = isRecord(raw.sender) ? raw.sender : undefined;
  const senderUserId = integerId(senderObj?.user_id, true) ?? userId;
  const senderNick = typeof senderObj?.nickname === "string" ? senderObj.nickname :
    typeof senderObj?.card === "string" ? senderObj.card : String(userId);

  // Prefer raw_message; fall back to building from message segments
  let rawMessage: string;
  if (typeof raw.raw_message === "string") {
    rawMessage = raw.raw_message;
  } else {
    rawMessage = segmentsToRawMessage(raw.message);
  }

  const event: RawMessageEvent = {
    message_type: msgType,
    user_id: userId,
    self_id: selfId,
    sender: {
      user_id: senderUserId,
      nickname: senderNick,
    },
    raw_message: rawMessage,
    message: raw.message ?? rawMessage,
    message_id: messageId,
    group_id: groupId,
  };

  // Pass through remaining fields for downstream use
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in event)) {
      (event as Record<string, unknown>)[k] = v;
    }
  }

  return event;
}

// ---------------------------------------------------------------------------
// API call response matching
// ---------------------------------------------------------------------------

/**
 * Pending API call tracker — maps echo string to its promise callbacks.
 */
interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Format a failed OneBot response without dropping adapter-specific details. */
export function formatOneBotApiError(response: Record<string, unknown>): string {
  const retcode = typeof response.retcode === "number" || typeof response.retcode === "string" ? String(response.retcode) : "unknown";
  const details = [response.msg, response.wording, response.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index);
  return `OneBot API error: retcode=${retcode}${details.length > 0 ? `: ${details.join("; ")}` : ""}`;
}

// ---------------------------------------------------------------------------
// OneBotAdapter
// ---------------------------------------------------------------------------

export class OneBotAdapter implements QQAdapter {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private echoCounter = 0;
  private pendingCalls = new Map<string, PendingCall>();
  private connectionWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(wsUrl?: string) {
    this.wsUrl = wsUrl ?? process.env.ONEBOT_WS_URL ?? DEFAULT_WS_URL;
  }

  // -----------------------------------------------------------------------
  // QQAdapter: lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.ws || this.reconnectTimer) return;
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearConnectTimer();
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Adapter stopped"));
    }
    this.connectionWaiters.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending calls
    for (const [, pc] of this.pendingCalls) {
      clearTimeout(pc.timer);
      pc.reject(new Error("Adapter stopped"));
    }
    this.pendingCalls.clear();

    if (this.ws) {
      // Remove listeners to prevent reconnect triggering
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* Already disconnected. */ }
      this.ws = null;
    }
  }

  // -----------------------------------------------------------------------
  // QQAdapter: message handler registration
  // -----------------------------------------------------------------------

  onMessage(handler: (msgCtx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // -----------------------------------------------------------------------
  // QQAdapter: API methods
  // -----------------------------------------------------------------------

  async sendPrivateMsg(userId: number, message: string): Promise<void> {
    const normalizedMessage = normalizeOutgoingMessage(message);
    await this.callApi("send_private_msg", {
      user_id: userId,
      message: normalizedMessage,
    });
  }

  async sendGroupMsg(groupId: number, message: string): Promise<void> {
    const normalizedMessage = normalizeOutgoingMessage(message);
    await this.callApi("send_group_msg", {
      group_id: groupId,
      message: normalizedMessage,
    });
  }

  async getGroupList(): Promise<Array<{ id: number; name: string }>> {
    const data = await this.callApi("get_group_list", {});
    const list = data as Array<Record<string, unknown>>;
    return (list ?? []).map((g) => ({
      id: typeof g.group_id === "number" ? g.group_id : Number(g.group_id),
      name: String(g.group_name ?? g.group_id ?? ""),
    }));
  }

  async getGroupMembers(
    groupId: number,
  ): Promise<Array<{ qq: number; nick: string; card: string; role: string }>> {
    const data = await this.callApi("get_group_member_list", {
      group_id: groupId,
    });
    const list = data as Array<Record<string, unknown>>;
    return (list ?? []).map((m) => ({
      qq: typeof m.user_id === "number" ? m.user_id : Number(m.user_id),
      nick: String(m.nickname ?? m.user_id ?? ""),
      card: String(m.card ?? ""),
      role: String(m.role ?? "member"),
    }));
  }

  async getGroupMsgHistory(
    groupId: number,
    count?: number,
  ): Promise<Array<{ qq: number; nick: string; text: string }>> {
    const data = await this.callApi("get_group_msg_history", {
      group_id: groupId,
      count: count ?? 20,
    });
    const msgs = (data as Record<string, unknown>)?.messages as Array<Record<string, unknown>> | undefined;
    return (msgs ?? []).map((m) => {
      const sender = m.sender as Record<string, unknown> | undefined;
      return {
        qq: typeof m.user_id === "number" ? m.user_id : Number(m.user_id),
        nick: String(sender?.nickname ?? m.user_id ?? ""),
        text: typeof m.raw_message === "string"
          ? m.raw_message
          : segmentsToRawMessage(m.message),
      };
    });
  }

  async getPrivateMsgHistory(
    userId: number,
    count?: number,
  ): Promise<Array<{ qq: number; nick: string; text: string }>> {
    const data = await this.callApi("get_private_msg_history", {
      user_id: userId,
      count: count ?? 20,
    });
    const msgs = (data as Record<string, unknown>)?.messages as Array<Record<string, unknown>> | undefined;
    return (msgs ?? []).map((m) => {
      const sender = m.sender as Record<string, unknown> | undefined;
      return {
        qq: typeof m.user_id === "number" ? m.user_id : Number(m.user_id),
        nick: String(sender?.nickname ?? m.user_id ?? ""),
        text: typeof m.raw_message === "string"
          ? m.raw_message
          : segmentsToRawMessage(m.message),
      };
    });
  }

  async getStrangerInfo(userId: number): Promise<unknown> {
    return this.callApi("get_stranger_info", { user_id: userId });
  }

  async deleteMsg(messageId: number): Promise<void> {
    await this.callApi("delete_msg", { message_id: messageId });
  }

  // -----------------------------------------------------------------------
  // WebSocket connection management
  // -----------------------------------------------------------------------

  /**
   * Connect to the OneBot WebSocket server.
   * Implements exponential backoff reconnect on failure.
   */
  private async connect(): Promise<void> {
    if (this.stopped || this.ws) return;

    console.log(`[onebot] connecting to ${this.wsUrl} ...`);

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[onebot] WebSocket constructor failed: ${msg}`);
      this.scheduleReconnect();
      return;
    }

    const ws = this.ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws) this.disconnectSocket(ws, "WebSocket connection timeout");
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return;
      this.clearConnectTimer();
      console.log(`[onebot] connected`);
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      for (const waiter of this.connectionWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.connectionWaiters.clear();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || this.stopped) return;
      try {
        this.handleMessage(event.data);
      } catch {
        console.warn("[onebot] invalid incoming message payload");
      }
    };

    ws.onerror = () => {
      if (this.ws === ws) this.disconnectSocket(ws, "WebSocket error");
    };

    ws.onclose = (event) => {
      if (this.ws === ws) this.disconnectSocket(ws, `WebSocket disconnected (code=${event.code})`);
    };
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private disconnectSocket(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return;
    console.error(`[onebot] ${reason}`);
    this.ws = null;
    this.clearConnectTimer();
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try { ws.close(); } catch { /* Failed connection may already be closed. */ }
    for (const pc of this.pendingCalls.values()) {
      clearTimeout(pc.timer);
      pc.reject(new Error(reason));
    }
    this.pendingCalls.clear();
    this.scheduleReconnect();
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    console.log(`[onebot] reconnecting in ${delay}ms ...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
      void this.connect();
    }, delay);
  }

  // -----------------------------------------------------------------------
  // Incoming message dispatch
  // -----------------------------------------------------------------------

  /**
   * Handle a raw WebSocket message (JSON string).
   * Distinguishes between server-pushed events and API call responses.
   */
  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      const str = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      parsed = JSON.parse(str);
    } catch {
      console.warn("[onebot] failed to parse incoming message");
      return;
    }
    if (!isRecord(parsed)) {
      console.warn("[onebot] invalid incoming message structure");
      return;
    }

    // ---- API response (has echo field) ----
    if (typeof parsed.echo === "string" && this.pendingCalls.has(parsed.echo)) {
      const echo = parsed.echo;
      const pc = this.pendingCalls.get(echo)!;
      this.pendingCalls.delete(echo);
      clearTimeout(pc.timer);

      if (parsed.status === "ok" || parsed.retcode === 0) {
        pc.resolve(parsed.data);
      } else {
        pc.reject(new Error(formatOneBotApiError(parsed)));
      }
      return;
    }

    // ---- Heartbeat ----
    if (
      parsed.post_type === "meta_event" &&
      parsed.meta_event_type === "heartbeat"
    ) {
      // Silently acknowledge heartbeats
      return;
    }

    // ---- Message event ----
    const rawEvent = parseOneBotEvent(parsed);
    if (!rawEvent) return;

    const ctx = buildCtx(rawEvent);

    // Dispatch to registered handler (fire-and-forget — errors caught inside)
    if (this.messageHandler) {
      const handler = this.messageHandler;
      void Promise.resolve().then(() => handler(ctx)).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[onebot] message handler error: ${msg}`);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Low-level API call (over WebSocket bidirectional channel)
  // -----------------------------------------------------------------------

  /**
   * Send a OneBot API call over the WebSocket and wait for its response.
   *
   * OneBot reverse-WS protocol: send `{ action, params, echo }`,
   * receive `{ status, retcode, data, echo }`.
   */
  async callApi(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.waitUntilConnected();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const echo = `qqbot-ts-${++this.echoCounter}-${Date.now()}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`OneBot API timeout: ${action} after ${API_TIMEOUT_MS}ms`));
      }, API_TIMEOUT_MS);

      this.pendingCalls.set(echo, { resolve, reject, timer });

      try {
        this.ws!.send(JSON.stringify({ action, params, echo }));
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pendingCalls.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async waitUntilConnected(timeoutMs = API_TIMEOUT_MS): Promise<void> {
    if (this.stopped) throw new Error("Adapter stopped");
    if (this.ws?.readyState === WebSocket.OPEN) return;

    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.connectionWaiters.delete(waiter);
        reject(new Error(`WebSocket not connected after ${timeoutMs}ms`));
      }, timeoutMs) };
      this.connectionWaiters.add(waiter);
    });
  }
}

// Re-export for convenience
export { DEFAULT_WS_URL };
