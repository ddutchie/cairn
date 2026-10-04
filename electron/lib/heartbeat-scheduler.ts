/**
 * Cairn — Heartbeat scheduler
 *
 * The single tick loop that drives scheduled automations while the app is open.
 * Design (from the openworker / hermes / openclaw synthesis):
 *   - Polls a durable SQLite `automations` table for due runs (default 30s tick).
 *   - run-once catch-up: the first tick fires anything missed while the app was
 *     down (a due automation always fires once, then next_run_at advances).
 *   - skip-on-overlap: never stacks a run whose previous fire is still running.
 *   - spawn-don't-await: each fire is delegated to an injected runner and the
 *     tick never blocks on it, so a slow run can't stall the loop or other runs.
 *
 * Engine-independent: the runner (the actual agent execution) is injected, so
 * this module has no knowledge of the agent loop, LLM config, or IPC.
 */

import type Database from "better-sqlite3";
import { computeNextRun, parseSchedule } from "./automation-schedule";
import {
  automationSpendSince,
  bumpAutomationRunCount,
  consecutiveFailedRuns,
  createAutomationRun,
  getAutomationById,
  getAutomationDailyBudget,
  getAutomationRunById,
  hasInFlightRun,
  listDueAutomations,
  updateAutomation,
  updateAutomationRun,
  type Automation,
  type AutomationRun,
} from "../db/automation-queries";
import { errMsg } from "../host-shared/errors";
import { insertNotification } from "../mcp/db";

/** Pause an automation after this many failed runs in a row. */
export const PAUSE_AFTER_FAILURES = 3;
/** First retry delay after a failure; doubles per consecutive failure (5m, 10m). */
export const RETRY_BASE_MS = 5 * 60_000;

export interface HeartbeatSchedulerOptions {
  /** Live DB accessor — re-read every tick so workspace reinitialise is transparent. */
  dbGetter: () => Database.Database | null;
  /** Executes one automation run. Must not throw (the scheduler catches). */
  runner: (run: AutomationRun, automation: Automation) => Promise<void>;
  /** Tick interval in ms. Default 30_000 (matches openworker). */
  tickMs?: number;
  /** Test seam / diagnostics. */
  log?: (msg: string) => void;
  /** Test seam — default Date.now. */
  now?: () => number;
}

export class HeartbeatScheduler {
  private opts: HeartbeatSchedulerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight: Promise<void> | null = null;
  private running = false;
  /** Local day (YYYY-MM-DD) we last notified "budget reached" for, so it's once a day. */
  private budgetNotifiedDay: string | null = null;

  constructor(opts: HeartbeatSchedulerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const { tickMs = 30_000 } = this.opts;
    // Fire an immediate catch-up tick, then poll on the interval.
    this.scheduleTick(0);
    this.timer = setInterval(() => this.scheduleTick(), tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public seam for tests — runs one tick synchronously-awaitable. */
  async tick(): Promise<void> {
    if (this.tickInFlight) await this.tickInFlight;
    const p = this.runTick();
    this.tickInFlight = p;
    try {
      await p;
    } finally {
      this.tickInFlight = null;
    }
  }

  private scheduleTick(delayMs?: number): void {
    void (async () => {
      if (delayMs) {
        await sleep(delayMs);
      }
      if (!this.running) return;
      await this.tick();
    })().catch((err) => {
      this.opts.log?.(`[heartbeat] tick error: ${String(err)}`);
    });
  }

  private async runTick(): Promise<void> {
    const db = this.opts.dbGetter();
    if (!db) return;
    const nowIso = new Date(this.opts.now?.() ?? Date.now()).toISOString();
    const due = listDueAutomations(db, nowIso);
    for (const automation of due) {
      try {
        this.fire(db, automation, nowIso);
      } catch (err) {
        this.opts.log?.(`[heartbeat] fire error for "${automation.name}": ${String(err)}`);
      }
    }
  }

  /**
   * Advance next_run_at, then spawn the runner (skip-on-overlap). Advances
   * happen synchronously so a crash mid-run doesn't re-fire immediately.
   * The active-hours window (if set) is checked BEFORE advancing — a due run
   * outside the window stays due and fires once the window opens.
   */
  private fire(db: Database.Database, automation: Automation, nowIso: string): void {
    if (!this.withinActiveHours(automation, nowIso)) {
      this.opts.log?.(`[heartbeat] "${automation.name}" deferred (outside active hours)`);
      return;
    }
    // A malformed scheduleExpr must not leave the automation due on every tick.
    let next: Date | null;
    try {
      next = computeNextRun(parseSchedule(automation.scheduleExpr), new Date(nowIso), automation.timezone ?? undefined);
    } catch {
      this.opts.log?.(`[heartbeat] "${automation.name}" disabled (invalid schedule)`);
      updateAutomation(db, automation.id, { enabled: false, nextRunAt: automation.nextRunAt });
      return;
    }
    const nextIso = next ? next.toISOString() : null;

    // Advance next_run_at first. If there's no future occurrence (e.g. a 'once'
    // in the past, or max_runs reached), disable the automation.
    const maxReached = automation.maxRuns !== null && automation.runCount >= automation.maxRuns;
    if (!nextIso || maxReached) {
      updateAutomation(db, automation.id, { enabled: false, nextRunAt: automation.nextRunAt });
      return;
    }
    updateAutomation(db, automation.id, { nextRunAt: nextIso });

    // skip-on-overlap — a previous fire still in flight for this automation.
    if (hasInFlightRun(db, automation.id)) {
      this.opts.log?.(`[heartbeat] skip overlap for "${automation.name}"`);
      return;
    }

    if (this.overBudget(db, automation, nowIso)) return;

    bumpAutomationRunCount(db, automation.id);
    const run = createAutomationRun(db, automation.id, "running");
    this.spawn(run, automation);
  }

  /**
   * Daily automation budget gate. When today's recorded automation spend has
   * reached the workspace budget, record a skipped run (visible in the run
   * history) instead of firing, and notify once per day.
   */
  private overBudget(db: Database.Database, automation: Automation, nowIso: string): boolean {
    const budget = getAutomationDailyBudget(db);
    if (budget === null) return false;
    const now = new Date(nowIso);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const spent = automationSpendSince(db, dayStart.getTime());
    if (spent < budget) return false;
    const reason = `Daily automation budget of $${budget.toFixed(2)} reached ($${spent.toFixed(2)} spent today)`;
    const run = createAutomationRun(db, automation.id, "skipped");
    updateAutomationRun(db, run.id, { error: reason, finishedAt: nowIso });
    this.opts.log?.(`[heartbeat] "${automation.name}" skipped: ${reason}`);
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (this.budgetNotifiedDay !== day) {
      this.budgetNotifiedDay = day;
      insertNotification(db, "automation_run", "Automation budget reached", `${reason}. Scheduled runs are skipped until tomorrow or until you raise the budget.`, { type: "automation", id: automation.id });
    }
    return true;
  }

  /**
   * Failure policy, applied after every scheduled run: pause the automation
   * after PAUSE_AFTER_FAILURES errors in a row; otherwise pull a recurring
   * automation's next run forward to a backoff retry (5m, 10m, …) when that
   * comes before its next scheduled time. 'once' automations are not retried.
   */
  private applyFailurePolicy(db: Database.Database, runId: string, automation: Automation): void {
    const run = getAutomationRunById(db, runId);
    if (run?.status !== "error") return;
    const fails = consecutiveFailedRuns(db, automation.id);
    const current = getAutomationById(db, automation.id);
    if (!current?.enabled) return;
    if (fails >= PAUSE_AFTER_FAILURES) {
      updateAutomation(db, automation.id, { enabled: false, nextRunAt: current.nextRunAt });
      const last = run.error ? ` Last error: ${run.error.slice(0, 160)}` : "";
      insertNotification(db, "automation_run", `Automation paused: "${automation.name}"`, `Paused after ${fails} failed runs in a row. Fix the cause, then turn it back on.${last}`, { type: "automation", id: automation.id });
      this.opts.log?.(`[heartbeat] "${automation.name}" paused after ${fails} consecutive failures`);
      return;
    }
    if (automation.scheduleKind === "once") return;
    const now = this.opts.now?.() ?? Date.now();
    const retryAt = now + RETRY_BASE_MS * 2 ** Math.max(0, fails - 1);
    if (new Date(current.nextRunAt).getTime() > retryAt) {
      updateAutomation(db, automation.id, { nextRunAt: new Date(retryAt).toISOString() });
      this.opts.log?.(`[heartbeat] "${automation.name}" failed; retrying at ${new Date(retryAt).toISOString()}`);
    }
  }

  /**
   * Active-hours gate: when the automation has a "HH:MM" start/end window, the
   * current wall-clock time (in the automation's timezone, else local) must fall
   * inside [start, end). end is exclusive; no midnight wrap in v1.
   */
  private withinActiveHours(automation: Automation, nowIso: string): boolean {
    if (!automation.activeHoursStart || !automation.activeHoursEnd) return true;
    const start = parseHm(automation.activeHoursStart);
    const end = parseHm(automation.activeHoursEnd);
    if (start === null || end === null) return true; // malformed → don't block
    const now = new Date(nowIso);
    let minutes: number;
    try {
      const tz = automation.timezone ?? undefined;
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", minute: "numeric", hour12: false,
      });
      const parts = dtf.formatToParts(now);
      let h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      if (h === 24) h = 0;
      const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      minutes = h * 60 + m;
    } catch {
      minutes = now.getHours() * 60 + now.getMinutes(); // bad tz → local
    }
    // Same-day window: inclusive start, exclusive end. Wrapping window
    // (start > end, e.g. 22:00–06:00) spans midnight: active at/after start OR
    // before end.
    return start <= end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end;
  }

  /**
   * Spawn-don't-await: run the runner in the background and record the outcome.
   * Contract: the runner is responsible for setting the run's terminal status
   * (done / skipped / denied). The scheduler only steps in to record an error
   * if the runner throws — it never overwrites a status the runner already set.
   */
  private spawn(run: AutomationRun, automation: Automation): void {
    void (async () => {
      const db = this.opts.dbGetter();
      try {
        await this.opts.runner(run, automation);
      } catch (err) {
        this.opts.log?.(`[heartbeat] runner error for "${automation.name}": ${String(err)}`);
        if (db) {
          updateAutomationRun(db, run.id, {
            status: "error",
            error: errMsg(err),
            finishedAt: new Date().toISOString(),
          });
        }
      }
      if (db) {
        try {
          this.applyFailurePolicy(db, run.id, automation);
        } catch (err) {
          this.opts.log?.(`[heartbeat] failure policy error for "${automation.name}": ${String(err)}`);
        }
      }
    })().catch(() => { /* runner errors already handled above */ });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse "HH:MM" to minutes-since-midnight, or null when malformed. */
function parseHm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
