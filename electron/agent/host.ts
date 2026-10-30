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
import { buildContextView, compactHistory, compactionThreshold, pruneToolResults } from "./context";
import type { AgentEvent } from "./events";
import { Gate, type AskSpec, type HumanDecision } from "./gate";
import { runTurn, type Profile, type StreamFn } from "./loop";
import { createRouteStream, reasoningOption, type ModelRoute, type RoutedStream } from "./provider";
import { createReviewerState, type Reviewer, type ReviewerState } from "./reviewer";
import { createRuleStore, type GrantKind, type Rule, type RuleStore } from "./rules";
import type { AgentTool } from "./tools";
import { createAdapter } from "./session/adapter";
import { deriveTitle, foldState } from "./session/history";
import { openSession, readSession, sessionDir, type SessionWriter } from "./session/log";
import { replayFromRecords } from "./session/replay";
import type { SessionRecord } from "./session/format";
import { rm } from "node:fs/promises";

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
}

interface Session {
  id: string;
  history: Message[];
  rules: RuleStore;
  doomAcked: Set<string>;
  reviewerState: ReviewerState;
  writer: SessionWriter;
  adapt: ReturnType<typeof createAdapter>;
  records: SessionRecord[];
  controller?: AbortController;
  /** callIds whose grant the human scoped to the workspace, awaiting the resulting rule. */
  workspaceGrantCalls: Set<string>;
  workspaceGrantArmed?: boolean;
  /** Serializes turns of one session. */
  running: boolean;
}

export class AgentHost {
  readonly gate = new Gate();
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<Session>>();

  constructor(private readonly deps: HostDeps) {
    if (deps.onAsk) this.gate.onAsk(deps.onAsk);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  private open(id: string, cwd: string): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) return Promise.resolve(existing);
    let pending = this.opening.get(id);
    if (!pending) {
      pending = (async () => {
        const { writer, existing: log } = await openSession(this.deps.root, { id, cwd });
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
          adapt: createAdapter(id),
          records: [...records],
          running: false,
          workspaceGrantCalls: new Set(),
        };
        this.sessions.set(id, session);
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
    this.sessions.delete(id);
  }

  /** Delete the session's log as well. */
  async destroy(id: string): Promise<void> {
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

  async prompt(req: PromptRequest): Promise<void> {
    const session = await this.open(req.sessionId, req.cwd);
    if (session.running) throw new Error("Session is busy — already running.");
    session.running = true;
    const controller = new AbortController();
    session.controller = controller;
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
        tools: req.tools,
        profile: req.profile,
        rules: this.ruleView(session),
        gate: this.gate,
        workspaceRoot: req.cwd,
        signal: controller.signal,
        maxSteps: req.maxSteps,
        askTtlMs: this.deps.askTtlMs,
        reviewer: this.deps.reviewer,
        reviewerState: session.reviewerState,
        doomAcked: session.doomAcked,
        streamOptions: { ...(reasoning ? { reasoning } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
        transformContext: (m) => pruneToolResults(m),
        compaction: {
          threshold,
          compact: (history, trigger) => compactHistory(history, trigger, { model, streamFn: streamFn as StreamFn, signal: controller.signal }),
        },
      });
      for await (const event of events) await this.record(session, event);
    } catch (err) {
      // runTurn reports its own failures as events; this is a host-level fault (e.g. the log write).
      this.deps.send("session:projection", makeSessionProjection(req.sessionId, "error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      session.running = false;
      session.controller = undefined;
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
    if (event.type === "turn/end") {
      const title = deriveTitle(session.records);
      if (title) this.deps.send("session:projection", makeSessionProjection(session.id, "title", { title }));
    }
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
