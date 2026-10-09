/**
 * 定时任务调度器 —— cron + interval 调度
 *
 * 对应 Python: src/qqbot/scheduler/cron.py
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ScheduledTask, SchedulerRef } from "../core/types.js";
import { askClaude } from "../ai/claude-code.js";
import { getConfig } from "../core/config.js";
import { getProjectSessionId } from "../core/encode-path.js";
import { withoutAccountingRequestContext } from "../core/accounting-request-context.js";
import { withSessionQueue } from "../core/session-queue.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function log(msg: string): void { console.log(`[scheduler] ${msg}`); }
function logErr(msg: string): void { console.error(`[scheduler] ${msg}`); }

// Node.js stores setTimeout delays as signed 32-bit integers. Larger values
// overflow and are coerced to 1ms, which can turn yearly/date-specific cron
// jobs into tight infinite loops after they fire once.
const MAX_TIMEOUT_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Cron field parser
// ---------------------------------------------------------------------------

/** Parse a single cron field (min/hour/dom/month/dow). Supports *, N, N,N, N-M, star/N, N-M/N. */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error("Invalid cron field");
    const range = match[1];
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const bounds = range === "*" ? [min, max] : range.split("-").map(Number);
    const rMin = bounds[0], rMax = bounds[1] ?? rMin;
    if (!Number.isSafeInteger(step) || step <= 0 || rMin < min || rMax > max || rMin > rMax) {
      throw new Error("Invalid cron range or step");
    }
    for (let i = rMin; i <= rMax; i += step) result.add(i);
  }
  return result;
}

interface CronFields {
  minutes: Set<number>; hours: Set<number>; dom: Set<number>;
  months: Set<number>; dow: Set<number>;
  domAny: boolean; dowAny: boolean;
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron: "${expr}"`);
  return {
    minutes: parseCronField(parts[0], 0, 59),
    hours: parseCronField(parts[1], 0, 23),
    dom: parseCronField(parts[2], 1, 31),
    months: parseCronField(parts[3], 1, 12),
    dow: parseCronField(parts[4], 0, 6),
    domAny: parts[2] === "*",
    dowAny: parts[4] === "*",
  };
}

function findNextInSet(set: Set<number>, current: number): number | null {
  let best: number | null = null;
  for (const v of set) { if (v >= current && (best === null || v < best)) best = v; }
  return best;
}

/** Compute next UTC time matching cron after `from` (exclusive). */
function nextCronTime(expr: string, from: Date): Date {
  const f = parseCron(expr);
  const next = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    from.getUTCHours(), from.getUTCMinutes() + 1, 0, 0,
  ));
  const limit = new Date(next.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 2);

  while (next <= limit) {
    const month = next.getUTCMonth() + 1, day = next.getUTCDate();
    const hour = next.getUTCHours(), minute = next.getUTCMinutes();
    const wday = next.getUTCDay();

    if (!f.months.has(month)) {
      if (month === 12) next.setUTCFullYear(next.getUTCFullYear() + 1, 0, 1);
      else next.setUTCMonth(month, 1);
      next.setUTCHours(0, 0, 0, 0); continue;
    }

    const domOk = f.dom.has(day), dowOk = f.dow.has(wday);
    let dayOk: boolean;
    if (f.domAny && f.dowAny) dayOk = true;
    else if (!f.domAny && !f.dowAny) dayOk = domOk || dowOk;
    else dayOk = f.domAny ? dowOk : domOk;

    if (!dayOk) { next.setUTCHours(24, 0, 0, 0); next.setUTCHours(0, 0, 0, 0); continue; }

    if (!f.hours.has(hour)) {
      const nh = findNextInSet(f.hours, hour);
      if (nh === null) { next.setUTCHours(24, 0, 0, 0); next.setUTCHours(0, 0, 0, 0); continue; }
      next.setUTCHours(nh, 0, 0, 0); continue;
    }

    if (!f.minutes.has(minute)) {
      const nm = findNextInSet(f.minutes, minute);
      if (nm === null) { next.setUTCHours(hour + 1, 0, 0, 0); continue; }
      next.setUTCMinutes(nm, 0, 0); continue;
    }

    return next;
  }
  throw new Error(`No cron match for "${expr}" within 2 years`);
}

// ---------------------------------------------------------------------------
// Scheduler implementation
// ---------------------------------------------------------------------------

interface JobEntry {
  timer: NodeJS.Timeout;
  fn: () => Promise<void>;
  running: boolean;
}

class SchedulerImpl implements SchedulerRef {
  private jobs = new Map<string, JobEntry>();

  addJob(
    fn: () => Promise<void>,
    trigger: { type: "interval"; minutes: number } | { type: "cron"; expression: string },
    id: string,
  ): void {
    if (trigger.type === "interval") {
      const ms = trigger.minutes * 60_000;
      if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) throw new Error("Invalid interval delay");
    } else {
      nextCronTime(trigger.expression, new Date());
    }
    this.removeJob(id);

    const run = async (entry: JobEntry): Promise<void> => {
      if (this.jobs.get(id) !== entry || entry.running) return;
      entry.running = true;
      try { await withoutAccountingRequestContext(fn); }
      catch (e: unknown) { logErr(`job ${id}: ${e}`); }
      finally { entry.running = false; }
    };

    if (trigger.type === "interval") {
      const ms = trigger.minutes * 60_000;
      const entry: JobEntry = { timer: setInterval(() => { void run(entry); }, ms), fn, running: false };
      this.jobs.set(id, entry);
      log(`added interval job ${id} (${trigger.minutes}m)`);
    } else {
      const scheduleNext = (): void => {
        if (this.jobs.get(id) !== placeholder) return;
        try {
          const next = nextCronTime(trigger.expression, new Date());
          const delay = next.getTime() - Date.now();
          if (delay <= 0) { placeholder.timer = setTimeout(scheduleNext, 1); return; }

          if (delay > MAX_TIMEOUT_MS) {
            const timer = setTimeout(scheduleNext, MAX_TIMEOUT_MS);
            const entry = this.jobs.get(id);
            if (entry) entry.timer = timer;
            log(`job ${id} next run exceeds max timeout; waiting in chunks until ${next.toISOString()}`);
            return;
          }

          const timer = setTimeout(() => {
            void run(placeholder).finally(scheduleNext);
          }, delay);
          const entry = this.jobs.get(id);
          if (entry) entry.timer = timer;
        } catch (e: unknown) { logErr(`job ${id} schedule: ${e}`); }
      };
      const placeholderTimer = setTimeout(() => {}, 0);
      clearTimeout(placeholderTimer);
      const placeholder = { timer: placeholderTimer, fn, running: false };
      this.jobs.set(id, placeholder);
      scheduleNext();
      log(`added cron job ${id} (${trigger.expression})`);
    }
  }

  removeJob(id: string): void {
    const entry = this.jobs.get(id);
    if (entry) { clearTimeout(entry.timer); clearInterval(entry.timer); this.jobs.delete(id); }
  }

  getJob(id: string): unknown {
    return this.jobs.get(id) ?? null;
  }

  stop(): void {
    for (const [id] of this.jobs) this.removeJob(id);
    log("stopped");
  }

  // ---- Extended API ----

  reloadFrom(sessionDir: string): void {
    const p = path.join(sessionDir, ".schedules.json");
    if (!fs.existsSync(p)) return;
    let tasks: unknown;
    try { tasks = JSON.parse(fs.readFileSync(p, "utf-8")); }
    catch { logErr(`reloadFrom: bad json ${p}`); return; }

    if (!Array.isArray(tasks)) { logErr(`reloadFrom: expected task array ${p}`); return; }
    for (const candidate of tasks) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        logErr("reloadFrom: invalid task structure"); continue;
      }
      const t = candidate as Partial<ScheduledTask>;
      if (typeof t.name !== "string" || !t.name.trim() || typeof t.msg !== "string" || !t.msg.trim() ||
          typeof t.cron !== "string" || (t.enabled !== undefined && typeof t.enabled !== "boolean")) {
        logErr("reloadFrom: invalid task fields"); continue;
      }
      if (t.enabled === false) continue;
      const jobId = `${sessionDir}::${t.name}`;
      if (this.jobs.has(jobId)) continue;
      const message = t.msg;
      try { this.addJob(
        () => fireCronJob(sessionDir, message),
        { type: "cron", expression: t.cron },
        jobId,
      ); } catch { logErr(`reloadFrom: invalid cron for task ${t.name}`); continue; }
      log(`reloaded job ${t.name} (${t.cron})`);
    }
  }

  removeAllFor(sessionDir: string): void {
    const prefix = `${sessionDir}::`;
    for (const [id] of this.jobs) {
      if (id.startsWith(prefix)) this.removeJob(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Fire callback — calls Claude for scheduled trigger messages
// ---------------------------------------------------------------------------

async function fireCronJob(sessionDir: string, triggerMsg: string): Promise<void> {
  return withSessionQueue(sessionDir, async () => {
  log(`firing: ${triggerMsg.slice(0, 80)}`);
  const now = new Date();
  const nowStr = now.toISOString().replace("T", " ").slice(5, 16);

  const fullMsg = `【定时任务触发】当前时间 ${nowStr}，任务：${triggerMsg}\n请按需执行，用 send_message 发消息。完成后 stdout 输出 ok`;

  try {
    const config = getConfig();
    let model: string | undefined = config.models[config.models.default] ?? config.models.flash;
    let effort: string | undefined = config.efforts.default;

    const mf = path.join(sessionDir, ".model");
    if (fs.existsSync(mf)) {
      const mn = fs.readFileSync(mf, "utf-8").trim();
      model = config.models[mn] ?? config.models.flash;
    }
    const ef = path.join(sessionDir, ".effort");
    if (fs.existsSync(ef)) effort = fs.readFileSync(ef, "utf-8").trim();

    const sessionId = getProjectSessionId(sessionDir, config.paths.projectsDir);

    const noAt = "触发定时任务。用 send_message 回复。需要艾特 QQ 用户时，message 必须使用 OneBot CQ 码 [CQ:at,qq=QQ号]，不要直接写 @QQ号。完成后只输出 ok。";
    const reply = await askClaude(fullMsg, sessionDir, sessionId, noAt, model, effort);
    log(`fired ok, stdout=${reply.slice(0, 100)}`);
  } catch (e: unknown) {
    logErr(`fire failed: ${e}`);
  }
  });
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: SchedulerImpl | null = null;

export function getScheduler(): SchedulerImpl {
  if (!_instance) _instance = new SchedulerImpl();
  return _instance;
}

export function startScheduler(): SchedulerImpl {
  log("started");
  return getScheduler();
}

export function reloadFrom(sessionDir: string): void {
  getScheduler().reloadFrom(sessionDir);
}

export function removeAllFor(sessionDir: string): void {
  getScheduler().removeAllFor(sessionDir);
}

export { SchedulerImpl };
