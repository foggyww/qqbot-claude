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
    if (part === "*") { for (let i = min; i <= max; i++) result.add(i); continue; }
    const slashIdx = part.indexOf("/");
    let range = part; let step = 1;
    if (slashIdx !== -1) {
      range = part.slice(0, slashIdx);
      step = parseInt(part.slice(slashIdx + 1), 10) || 1;
    }
    let rMin: number, rMax: number;
    const dashIdx = range.indexOf("-");
    if (range === "*") { rMin = min; rMax = max; }
    else if (dashIdx !== -1) { rMin = parseInt(range.slice(0, dashIdx), 10); rMax = parseInt(range.slice(dashIdx + 1), 10); }
    else { rMin = rMax = parseInt(range, 10); }
    if (isNaN(rMin) || isNaN(rMax)) continue;
    rMin = Math.max(rMin, min); rMax = Math.min(rMax, max);
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
}

class SchedulerImpl implements SchedulerRef {
  private jobs = new Map<string, JobEntry>();

  addJob(
    fn: () => Promise<void>,
    trigger: { type: "interval"; minutes: number } | { type: "cron"; expression: string },
    id: string,
  ): void {
    this.removeJob(id);

    if (trigger.type === "interval") {
      const ms = trigger.minutes * 60_000;
      const timer = setInterval(() => {
        fn().catch((e: unknown) => logErr(`job ${id}: ${e}`));
      }, ms);
      this.jobs.set(id, { timer, fn });
      log(`added interval job ${id} (${trigger.minutes}m)`);
    } else {
      const scheduleNext = (): void => {
        try {
          const next = nextCronTime(trigger.expression, new Date());
          const delay = next.getTime() - Date.now();
          if (delay <= 0) { setTimeout(scheduleNext, 0); return; }

          if (delay > MAX_TIMEOUT_MS) {
            const timer = setTimeout(scheduleNext, MAX_TIMEOUT_MS);
            const entry = this.jobs.get(id);
            if (entry) entry.timer = timer;
            log(`job ${id} next run exceeds max timeout; waiting in chunks until ${next.toISOString()}`);
            return;
          }

          const timer = setTimeout(() => {
            fn().catch((e: unknown) => logErr(`job ${id}: ${e}`)).finally(scheduleNext);
          }, delay);
          const entry = this.jobs.get(id);
          if (entry) entry.timer = timer;
        } catch (e: unknown) { logErr(`job ${id} schedule: ${e}`); }
      };
      const placeholder = { timer: setTimeout(() => {}, 0), fn };
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

  // ---- Extended API ----

  reloadFrom(sessionDir: string): void {
    const p = path.join(sessionDir, ".schedules.json");
    if (!fs.existsSync(p)) return;
    let tasks: ScheduledTask[];
    try { tasks = JSON.parse(fs.readFileSync(p, "utf-8")); }
    catch { logErr(`reloadFrom: bad json ${p}`); return; }

    for (const t of tasks) {
      if (t.enabled === false) continue;
      const jobId = `${sessionDir}::${t.name}`;
      if (this.jobs.has(jobId)) continue;
      this.addJob(
        () => fireCronJob(sessionDir, t.msg),
        { type: "cron", expression: t.cron },
        jobId,
      );
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
