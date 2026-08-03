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
  bumpAutomationRunCount,
  createAutomationRun,
  hasInFlightRun,
  listDueAutomations,
  updateAutomation,
  updateAutomationRun,
  type Automation,
  type AutomationRun,
} from "../db/automation-queries";

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
      if (!this.running && delayMs === 0) {
        // first call from start() happens before any await; keep running guard
      }
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
   */
  private fire(db: Database.Database, automation: Automation, nowIso: string): void {
    const next = computeNextRun(parseSchedule(automation.scheduleExpr), new Date(nowIso), automation.timezone ?? undefined);
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

    bumpAutomationRunCount(db, automation.id);
    const run = createAutomationRun(db, automation.id, "running");
    this.spawn(run, automation);
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
            error: err instanceof Error ? err.message : String(err),
            finishedAt: new Date().toISOString(),
          });
        }
      }
    })().catch(() => { /* runner errors already handled above */ });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
