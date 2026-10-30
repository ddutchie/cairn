/**
 * AgentHost: the one place sessions live. Owns per-session state (history,
 * rules, abort), runs turns through `runTurn`, appends every event to the
 * session log before forwarding it, and exposes the operations the IPC layer
 * needs (prompt / abort / answer an approval / recover pending asks / replay).
 *
 * No Electron imports: the transport is injected as `send`, so the host is
 * testable with a faux model. See docs/plans/agent-engine-design.md.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { LoadSessionMessagesResult } from "../../shared/agent/session-wire";
import { makeSessionProjection, type SessionProjection } from "../../shared/agent/session-projection";
import type { SessionEventEnvelope } from "../../shared/agent/session-event";
import { buildContextView, renderTranscript, compactHistory, compactionThreshold, pruneImages, pruneToolResults } from "./context";
import type { AgentEvent, GoalPhase, GoalState, ScheduleEntry, UserImage } from "./events";
import { Gate, type AskSpec, type HumanDecision } from "./gate";
import { runTurn, type Profile, type StreamFn } from "./loop";
import { createRouteStream, reasoningOption, type ModelRoute, type RoutedStream } from "./provider";
import { createReviewerState, type Reviewer, type ReviewerState } from "./reviewer";
import { createRuleStore, type GrantKind, type Rule, type RuleStore } from "./rules";
import type { AgentTool } from "./tools";
import { createAdapter } from "./session/adapter";
import { createTraceAdapter } from "./session/trace";
import { deriveTitle, foldGoal, foldSchedules, foldState } from "./session/history";
import { listSessions, openSession, readSession, sessionDir, type SessionWriter } from "./session/log";
import { replayFromRecords } from "./session/replay";
import type { SessionRecord } from "./session/format";
import { rm } from "node:fs/promises";

/** `/compact` keeps about one exchange verbatim; automatic compaction keeps more. */
const MANUAL_KEEP_RECENT_TOKENS = 4_000;

export type HostChannel = "session:event" | "session:projection";
export type HostSend = (channel: HostChannel, payload: SessionEventEnvelope | SessionProjection) => void;

export interface HostDeps {
  /** Directory holding one folder per session log. */
  root: string;
  send: HostSend;
  /** Rules that apply to every session (presets, user rules). */
  globalRules?: (sessionId: string) => readonly Rule[];
  /** A grant the human scoped to "workspace": persist it beyond this session. */
  onWorkspaceGrant?: (sessionId: string, rule: Rule) => void;
  /** Override the model transport (tests inject a faux one). */
  routeStream?: (route: ModelRoute) => RoutedStream;
  reviewer?: Reviewer;
  askTtlMs?: number;
  /** Called for each `approval/asked`, e.g. to raise a desktop notification. */
  onAsk?: (ask: AskSpec) => void;
  /** Each settled assistant message (e.g. to record token usage). */
  onAssistantMessage?: (sessionId: string, message: AssistantMessage) => void;
}

export interface PromptRequest {
  sessionId: string;
  prompt: string;
  images?: readonly UserImage[];
  cwd: string;
  profile: Profile;
  route: ModelRoute;
  systemPrompt: string;
  tools: readonly AgentTool[];
  reasoningEffort?: string;
  temperature?: number;
  maxSteps?: number;
  /** Fixed title to record (e.g. a coding-session task title). */
  title?: string;
  /** Set for a subagent: its events are shown as traces under this session, and it asks through it. */
  parentSession?: string;
  /** Aborts this turn (a subagent stops when its parent does). */
  signal?: AbortSignal;
}

export interface PromptOutcome {
  /** The last assistant text of the turn. */
  text: string;
  reason: string;
}

/** Continuation rounds a goal gets unless the model asks for another number. */
const DEFAULT_GOAL_ROUNDS = 10;
const GOAL_CONTINUE = (objective: string) =>
  `Continue working toward the goal: ${objective}\nWhen it is met call update_goal with phase "complete"; if you cannot proceed call it with phase "blocked" and a blockedReason.`;
/** How long a reminder waits when its session is mid-turn before trying again. */
const REMINDER_RETRY_MS = 15_000;

export interface ChildInfo { id: string; label: string; running: boolean }

interface Session {
  id: string;
  history: Message[];
  rules: RuleStore;
  doomAcked: Set<string>;
  reviewerState: ReviewerState;
  writer: SessionWriter;
  adapt: (event: AgentEvent) => ReturnType<ReturnType<typeof createAdapter>>;
  parent?: string;
  records: SessionRecord[];
  controller?: AbortController;
  /** callIds whose grant the human scoped to the workspace, awaiting the resulting rule. */
  workspaceGrantCalls: Set<string>;
  workspaceGrantArmed?: boolean;
  /** Serializes turns of one session. */
  running: boolean;
  /** The last request, so a reminder can prompt the session the same way. */
  lastReq?: PromptRequest;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Things that happened while the model wasn't looking (finished jobs); shown at the next turn. */
  notices: string[];
}

export class AgentHost {
  readonly gate = new Gate();
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<Session>>();

  constructor(private readonly deps: HostDeps) {
    if (deps.onAsk) this.gate.onAsk(deps.onAsk);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  private open(id: string, cwd: string, parent?: string): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) return Promise.resolve(existing);
    let pending = this.opening.get(id);
    if (!pending) {
      pending = (async () => {
        const { writer, existing: log } = await openSession(this.deps.root, { id, cwd, parentId: parent });
        const records = log?.records ?? [];
        const state = foldState(records);
        const session: Session = {
          id,
          history: buildContextView(records),
          // Grants persist in the log, so "always allow" survives restarts.
          rules: createRuleStore(state.rules),
          doomAcked: new Set(),
          reviewerState: createReviewerState(),
          writer,
          adapt: (log?.header.parentId ?? parent) ? createTraceAdapter(log?.header.parentId ?? parent!, id) : createAdapter(id),
          parent: log?.header.parentId ?? parent,
          records: [...records],
          running: false,
          workspaceGrantCalls: new Set(),
          timers: new Map(),
          notices: [],
        };
        this.sessions.set(id, session);
        for (const entry of foldSchedules(records)) this.arm(session, entry);
        return session;
      })().finally(() => this.opening.delete(id));
      this.opening.set(id, pending);
    }
    return pending;
  }

  isRunning(id: string): boolean { return this.sessions.get(id)?.running === true; }
  runningIds(): string[] { return [...this.sessions.values()].filter((s) => s.running).map((s) => s.id); }

  abort(id: string): void {
    this.sessions.get(id)?.controller?.abort();
    this.gate.cancelSession(id);
  }

  /** Forget in-memory state and cancel anything pending; the log stays. */
  release(id: string): void {
    this.abort(id);
    for (const t of this.sessions.get(id)?.timers.values() ?? []) clearTimeout(t);
    this.sessions.delete(id);
  }

  /** Delete the session's log as well, and its subagents'. */
  async destroy(id: string): Promise<void> {
    for (const child of await this.listChildren(id)) {
      this.release(child.id);
      await rm(sessionDir(this.deps.root, child.id), { recursive: true, force: true });
    }
    this.release(id);
    await rm(sessionDir(this.deps.root, id), { recursive: true, force: true });
  }

  // ── approvals ─────────────────────────────────────────────────────────

  respondTool(sessionId: string, callId: string, nonce: string | undefined, decision: { approved: boolean; grant?: "session" | "command" | "workspace" }): boolean {
    if (!nonce) return false;
    const grant: GrantKind | undefined = decision.grant === "command" ? "command" : decision.grant ? "tool" : undefined;
    if (decision.approved && decision.grant === "workspace") this.sessions.get(sessionId)?.workspaceGrantCalls.add(callId);
    const human: HumanDecision = { approved: decision.approved, ...(grant ? { grant } : {}) };
    return this.gate.resolve(sessionId, callId, nonce, human);
  }

  /** Asks still waiting, so a reloaded renderer can redraw its cards. */
  pendingAsks(sessionId: string): AskSpec[] { return this.gate.pending(sessionId); }

  // ── turns ─────────────────────────────────────────────────────────────

  async prompt(req: PromptRequest): Promise<PromptOutcome> {
    const session = await this.open(req.sessionId, req.cwd, req.parentSession);
    if (session.running) throw new Error("Session is busy — already running.");
    session.running = true;
    session.lastReq = req;
    const notices = session.notices.splice(0);
    let outcome = await this.runTurnOnce(session, notices.length ? { ...req, prompt: `${notices.map((n) => `<notice>${n}</notice>`).join("\n")}\n${req.prompt}` } : req);
    // A standing goal keeps the session going until it is met, blocked or out of rounds.
    while (!session.parent && outcome.reason === "stop" && !req.signal?.aborted) {
      const goal = foldGoal(session.records);
      if (!goal || goal.phase !== "active" || goal.roundsStarted >= goal.maxGoalRounds) break;
      await this.record(session, { type: "goal/changed", operation: "round", goal: { ...goal, roundsStarted: goal.roundsStarted + 1, revision: goal.revision + 1, updatedAt: Date.now() } });
      outcome = await this.runTurnOnce(session, { ...req, prompt: GOAL_CONTINUE(goal.objective) });
    }
    session.running = false;
    return outcome;
  }

  private async runTurnOnce(session: Session, req: PromptRequest): Promise<PromptOutcome> {
    const controller = new AbortController();
    session.controller = controller;
    const outcome: PromptOutcome = { text: "", reason: "error" };
    const link = () => controller.abort();
    if (req.signal?.aborted) controller.abort(); else req.signal?.addEventListener("abort", link, { once: true });
    try {
      const { model, streamFn } = (this.deps.routeStream ?? createRouteStream)(req.route);
      const reasoning = reasoningOption(model, req.reasoningEffort);
      const threshold = compactionThreshold(model.contextWindow, model.maxTokens);
      const events = runTurn({
        sessionId: req.sessionId,
        model,
        streamFn,
        systemPrompt: req.systemPrompt,
        history: session.history,
        input: req.prompt,
        images: req.images,
        tools: req.tools,
        profile: req.profile,
        rules: this.ruleView(session),
        gate: this.gate,
        workspaceRoot: req.cwd,
        askSessionId: session.parent,
        signal: controller.signal,
        maxSteps: req.maxSteps,
        askTtlMs: this.deps.askTtlMs,
        reviewer: this.deps.reviewer,
        reviewerState: session.reviewerState,
        doomAcked: session.doomAcked,
        streamOptions: { ...(reasoning ? { reasoning } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
        transformContext: (m) => pruneImages(pruneToolResults(m)),
        compaction: {
          threshold,
          compact: (history, trigger) => compactHistory(history, trigger, { model, streamFn: streamFn as StreamFn, signal: controller.signal }),
        },
      });
      for await (const event of events) {
        await this.record(session, event);
        if (event.type === "assistant/message") outcome.text = event.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        else if (event.type === "turn/end") outcome.reason = event.reason;
      }
    } catch (err) {
      // runTurn reports its own failures as events; this is a host-level fault (e.g. the log write).
      this.deps.send("session:projection", makeSessionProjection(req.sessionId, "error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      req.signal?.removeEventListener("abort", link);
      session.controller = undefined;
    }
    return outcome;
  }

  /**
   * Compact on demand. The `compaction` event is logged and projected like an automatic one.
   * Returns false when the history has nothing worth folding.
   */
  async compact(sessionId: string, cwd: string, route: ModelRoute): Promise<boolean> {
    const session = await this.open(sessionId, cwd);
    if (session.running) throw new Error("Session is busy — already running.");
    session.running = true;
    try {
      const { model, streamFn } = (this.deps.routeStream ?? createRouteStream)(route);
      const result = await compactHistory(session.history, "manual", { model, streamFn: streamFn as StreamFn, keepRecentTokens: MANUAL_KEEP_RECENT_TOKENS });
      if (!result) return false;
      session.history.splice(0, session.history.length, ...result.history);
      await this.record(session, result.event);
      return true;
    } finally {
      session.running = false;
    }
  }

  /** Global rules first, then the session's grants; `add` always lands in the session store. */
  private ruleView(session: Session): RuleStore {
    const global = this.deps.globalRules;
    return {
      list: () => (global ? [...global(session.id), ...session.rules.list()] : session.rules.list()),
      add: (rule) => session.rules.add(rule),
      remove: (id) => session.rules.remove(id),
    };
  }

  private async record(session: Session, event: AgentEvent): Promise<void> {
    const rec = await session.writer.append(event);
    if (rec) session.records.push(rec);
    if (event.type === "approval/decided" && event.grant && session.workspaceGrantCalls.delete(event.callId)) session.workspaceGrantArmed = true;
    else if (event.type === "rule/added" && session.workspaceGrantArmed) {
      session.workspaceGrantArmed = false;
      try { this.deps.onWorkspaceGrant?.(session.id, event.rule); } catch { /* persistence is best effort; the session grant still applies */ }
    }
    if (event.type === "assistant/message") {
      try { this.deps.onAssistantMessage?.(session.id, event.message); } catch { /* accounting must never break a turn */ }
    }
    const out = session.adapt(event);
    for (const e of out.events) this.deps.send("session:event", { sessionId: session.id, event: e });
    for (const p of out.projections) this.deps.send("session:projection", p);
    if (event.type === "turn/end" && !session.parent) {
      const title = deriveTitle(session.records);
      if (title) this.deps.send("session:projection", makeSessionProjection(session.id, "title", { title }));
    }
  }

  // ── goal, reminders, notices ──────────────────────────────────────────

  goal(sessionId: string): GoalState | null {
    const live = this.sessions.get(sessionId);
    return live ? foldGoal(live.records) : null;
  }

  async readGoal(sessionId: string): Promise<GoalState | null> {
    const live = this.sessions.get(sessionId);
    if (live) return foldGoal(live.records);
    return foldGoal((await readSession(this.deps.root, sessionId))?.records ?? []);
  }

  async createGoal(sessionId: string, objective: string, maxRounds?: number): Promise<GoalState> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session is not open.");
    const now = Date.now();
    const goal: GoalState = {
      id: `goal-${now.toString(36)}`, revision: 1, objective, phase: "active", roundsStarted: 0,
      maxGoalRounds: Math.max(1, Math.floor(maxRounds ?? DEFAULT_GOAL_ROUNDS)), createdAt: now, updatedAt: now,
    };
    await this.record(session, { type: "goal/changed", operation: "create", goal });
    return goal;
  }

  async updateGoal(sessionId: string, patch: { phase?: GoalPhase; blockedReason?: string }): Promise<GoalState | undefined> {
    const session = this.sessions.get(sessionId);
    const current = session && foldGoal(session.records);
    if (!session || !current) return undefined;
    const phase = patch.phase ?? current.phase;
    const next: GoalState = {
      ...current, phase, revision: current.revision + 1, updatedAt: Date.now(),
      blockedReason: phase === "blocked" ? patch.blockedReason ?? current.blockedReason ?? "No reason given." : undefined,
    };
    await this.record(session, { type: "goal/changed", operation: "update", goal: next });
    return next;
  }

  async clearGoal(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && foldGoal(session.records)) await this.record(session, { type: "goal/changed", operation: "clear", goal: null });
  }

  async readSchedules(sessionId: string): Promise<ScheduleEntry[]> {
    const live = this.sessions.get(sessionId);
    return foldSchedules(live?.records ?? (await readSession(this.deps.root, sessionId))?.records ?? []);
  }

  schedules(sessionId: string): ScheduleEntry[] {
    return foldSchedules(this.sessions.get(sessionId)?.records ?? []);
  }

  async addSchedule(sessionId: string, prompt: string, at: Date, kind: ScheduleEntry["kind"]): Promise<ScheduleEntry> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session is not open.");
    const entry: ScheduleEntry = { id: `rem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, prompt, at: at.toISOString(), kind };
    await this.record(session, { type: "schedule/changed", operation: "add", schedule: entry });
    this.arm(session, entry);
    return entry;
  }

  async cancelSchedule(sessionId: string, id: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const entry = session && foldSchedules(session.records).find((e) => e.id === id);
    if (!session || !entry) return false;
    clearTimeout(session.timers.get(id));
    session.timers.delete(id);
    await this.record(session, { type: "schedule/changed", operation: "cancel", schedule: entry });
    return true;
  }

  private arm(session: Session, entry: ScheduleEntry, delay = Math.max(0, Date.parse(entry.at) - Date.now())): void {
    // setTimeout cannot reach past ~24 days; the 30-day cap is handled by re-arming.
    const wait = Math.min(delay, 2_000_000_000);
    const timer = setTimeout(() => void this.fire(session, entry, delay - wait), wait);
    timer.unref?.();
    session.timers.set(entry.id, timer);
  }

  private async fire(session: Session, entry: ScheduleEntry, remaining: number): Promise<void> {
    session.timers.delete(entry.id);
    if (!foldSchedules(session.records).some((e) => e.id === entry.id) || this.sessions.get(session.id) !== session) return;
    if (remaining > 0) return this.arm(session, entry, remaining);
    const req = session.lastReq;
    // Without a request to copy (a session reopened after a restart) the reminder waits, shown as overdue.
    if (!req) return;
    if (session.running) return this.arm(session, entry, REMINDER_RETRY_MS);
    await this.record(session, { type: "schedule/changed", operation: "fire", schedule: entry });
    await this.prompt({ ...req, prompt: `Reminder: ${entry.prompt}`, signal: undefined }).catch(() => undefined);
  }

  /** Leave a note for the model; it is shown at the start of the session's next turn. */
  notify(sessionId: string, text: string): void {
    this.sessions.get(sessionId)?.notices.push(text);
  }

  /** The session's conversation as text, for a child that should see it. */
  transcript(sessionId: string): string {
    const history = this.sessions.get(sessionId)?.history;
    return history ? renderTranscript(history) : "";
  }

  /** The subagents a session has started, from their logs (survives restarts). */
  async listChildren(parentId: string): Promise<ChildInfo[]> {
    const out: ChildInfo[] = [];
    for (const id of await listSessions(this.deps.root)) {
      if (!id.startsWith(`${parentId}.sub-`)) continue;
      const log = this.sessions.get(id) ? undefined : await readSession(this.deps.root, id).catch(() => undefined);
      const header = this.sessions.get(id)?.writer.header ?? log?.header;
      if (header?.parentId !== parentId) continue;
      const records = this.sessions.get(id)?.records ?? log?.records ?? [];
      const first = records.find((r) => r.event.type === "user/message")?.event;
      out.push({ id, label: first && first.type === "user/message" ? first.content.trim().replace(/\s+/g, " ").slice(0, 60) : "subagent", running: this.isRunning(id) });
    }
    return out;
  }

  /** Pin a title (manual rename). */
  async rename(sessionId: string, title: string, cwd = ""): Promise<string> {
    const clean = title.trim();
    if (!clean) throw new Error("title must be non-empty");
    await this.record(await this.open(sessionId, cwd), { type: "session/title", title: clean });
    return clean;
  }

  // ── reads ─────────────────────────────────────────────────────────────

  async loadMessages(sessionId: string, contextWindow?: number): Promise<LoadSessionMessagesResult> {
    const live = this.sessions.get(sessionId);
    const log = live ? undefined : await readSession(this.deps.root, sessionId);
    const records = live?.records ?? log?.records ?? [];
    return replayFromRecords(records, log?.header.title ?? deriveTitle(records), contextWindow);
  }

  async title(sessionId: string): Promise<string | null> {
    const live = this.sessions.get(sessionId);
    if (live) return deriveTitle(live.records) ?? null;
    const log = await readSession(this.deps.root, sessionId);
    return log ? (log.header.title ?? deriveTitle(log.records) ?? null) : null;
  }

}
