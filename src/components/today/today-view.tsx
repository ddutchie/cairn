"use client";

/**
 * The Today view: one brief per workspace, written by the built-in Today
 * automation (`electron/lib/today.ts`). A headline naming the first decision,
 * four stat tiles, the cairn stack, the day strip (free time first), the three
 * lanes (Need you as decisions, Prepared for you, Moving without you), and
 * Your projects (facts Cairn computes itself). A draft that answers a decision
 * sits on that decision's choice, not in Prepared. Items carry the project
 * they belong to. While a run gathers, items arrive one tool call at a time
 * (`today:updated`). When Today is off the view shows its setup instead.
 *
 * Every action here is local or goes through chat: drafts are copied, or handed
 * to a chat session that asks before it posts anything.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, MessageSquare, NotebookText, Pencil, Play, RefreshCw, RotateCcw, Settings2, X } from "lucide-react";
import { MarkdownContent } from "@/components/conversation/MarkdownContent";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { todayClient, automationsClient } from "@/lib/ipc/automations";
import { humanizedRunStep } from "@/lib/humanize-tool";
import { connectorForTool, useCommunityConnectorMap } from "@/components/chat/chat-panel/connector-context";
import { appClient } from "@/lib/ipc/app";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Toggle } from "@/components/ui/toggle";
import { ModalShell } from "@/components/ui/modal-shell";
import { Tooltip } from "@/components/ui/tooltip";
import { useContainerDims, useFontScale, useNow } from "@/lib/viz/hooks";
import { TodayActPanel, type TodayActTarget } from "./today-act-panel";
import { CairnStack, MiniStack, TODAY_SEEN_EVENT, markTodaySeen, todaySeenAt, type StackLane } from "./today-stack";
import { TodayPastBanner, TodayRail } from "./today-rail";
import { compareTodayBriefs, groupTodayHistory, type TodayComparison } from "../../../shared/today/history";
import {
  EMPTY_TODAY_MARKS, dayBlocks, formatClock, formatMinutes, linkedDraftIds, localDate,
  type TodayBrief, type TodayDay, type TodayHistoryEntry, type TodayRunActivity, type TodayFyi, type TodayMarks, type TodayNeedItem, type TodayPrepared, type TodayProjectFacts, type TodaySettings as TodaySettingsValue, type TodayState,
} from "../../../shared/today/brief";

/** Project id → name, for the project chip on each item. */
const ProjectNames = createContext<Map<string, string>>(new Map());

type Lane = StackLane;

// Marks used to live in localStorage; read once to move them to the brief folder.
const LEGACY_KEYS = (workspaceId: string, date: string) =>
  [`today:dismissed:ws:${workspaceId}:${date}`, `today:edits:ws:${workspaceId}:${date}`] as const;

function readJson<T>(key: string, fallback: T): T {
  try { return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback; } catch { return fallback; }
}

type MarkPatch = { done?: Record<string, boolean>; edits?: Record<string, string | null> };

function applyPatch(m: TodayMarks, patch: MarkPatch): TodayMarks {
  const done = new Set(m.done);
  for (const [id, on] of Object.entries(patch.done ?? {})) { if (on) done.add(id); else done.delete(id); }
  const edits = { ...m.edits };
  for (const [id, text] of Object.entries(patch.edits ?? {})) { if (text === null) delete edits[id]; else edits[id] = text; }
  return { done: [...done], edits };
}

/**
 * Done items and edited drafts for one day, kept in the brief folder by main
 * (so the next day's run knows what's still open). Updated optimistically;
 * `readOnly` (an old version from the history) never writes.
 */
function useMarks(workspaceId: string, date: string | undefined, initial: TodayMarks, readOnly = false) {
  const [marks, setMarks] = useState(initial);
  const [from, setFrom] = useState(initial);
  // A fresh state from main (a refresh, a brief update) replaces the local copy.
  if (from !== initial) { setFrom(initial); setMarks(initial); }
  const send = useCallback((patch: MarkPatch) => {
    if (!date || readOnly) return;
    setMarks((m) => applyPatch(m, patch));
    todayClient.mark(workspaceId, date, patch).then(setMarks).catch(() => { /* kept locally until the next refresh */ });
  }, [workspaceId, date, readOnly]);

  // One-time move of marks this browser kept before they were stored with the brief.
  useEffect(() => {
    if (!date || readOnly) return;
    const [doneKey, editsKey] = LEGACY_KEYS(workspaceId, date);
    const done = readJson<string[]>(doneKey, []);
    const edits = readJson<Record<string, string>>(editsKey, {});
    if (done.length === 0 && Object.keys(edits).length === 0) return;
    todayClient.mark(workspaceId, date, { done: Object.fromEntries(done.map((id) => [id, true])), edits })
      .then((m) => { setMarks(m); localStorage.removeItem(doneKey); localStorage.removeItem(editsKey); })
      .catch(() => { /* try again next time */ });
  }, [workspaceId, date, readOnly]);

  const ids = useMemo(() => new Set(marks.done), [marks.done]);
  const toggle = useCallback((id: string) => send({ done: { [id]: !ids.has(id) } }), [send, ids]);
  const set = useCallback((id: string, on: boolean) => { if (ids.has(id) !== on) send({ done: { [id]: on } }); }, [send, ids]);
  const setEdit = useCallback((id: string, text: string | null) => send({ edits: { [id]: text } }), [send]);
  return { ids, toggle, set, edits: marks.edits, setEdit };
}

function openUrl(url?: string) {
  if (url && /^https?:\/\//i.test(url)) void appClient.openExternal(url);
}

/** The Today view: the active workspace's brief. */
export function TodayView() {
  const workspaceId = useCairnStore((s) => s.activeWorkspaceId);
  return (
    <div className="@container flex-1 overflow-y-auto overflow-x-hidden">
      <div className="max-w-[1240px] mx-auto w-full px-4 pt-4 md:px-7 md:pt-6 pb-8">
        {workspaceId ? <TodayPanel key={workspaceId} workspaceId={workspaceId} /> : <Empty>Open a workspace to see Today.</Empty>}
      </div>
    </div>
  );
}

function TodayPanel({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<TodayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A run's last brief save failed: the brief on screen may be older than what the run found.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveTool, setLiveTool] = useState<TodayRunActivity | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await todayClient.get(workspaceId);
      setState(next);
      // The main process knows what a run is doing, so a view opened mid-run (or reopened) shows it too.
      setLiveTool((cur) => (next.running ? next.activity ?? cur : null));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the brief from the main process on open
  useEffect(() => { void refresh(); }, [refresh]);

  // Each brief tool call saves the brief: reload so items arrive as the run finds them.
  // A finished update can also change the saved days (sample days added or removed), so the rail reloads too.
  const [historyTick, setHistoryTick] = useState(0);
  useEffect(() => todayClient.onUpdated((ev) => {
    if (ev.workspaceId !== workspaceId) return;
    setSaveError(ev.saveError ? `Couldn't save the brief: ${ev.saveError}` : null);
    void refresh();
    if (ev.status === "ready") setHistoryTick((n) => n + 1);
  }), [workspaceId, refresh]);

  // Live progress: which tool the run is on, and a refetch when it ends.
  useEffect(() => {
    if (!state?.automationId) return;
    const id = state.automationId;
    return automationsClient.onRunEvent((ev) => {
      if (ev.automationId !== id) return;
      if (ev.event === "started") { setLiveTool({ tool: null }); setState((s) => (s ? { ...s, running: true } : s)); }
      if (ev.event === "tool" && ev.status === "start" && ev.tool) setLiveTool({ tool: ev.tool, label: ev.label, args: ev.args });
      if (ev.event === "finished") {
        setLiveTool(null);
        // The run row is closed just after `finished` is sent.
        window.setTimeout(() => void refresh(), 600);
      }
    });
  }, [state?.automationId, refresh]);

  // Fallback while a run is in flight (e.g. a scheduled run started before this view opened).
  useEffect(() => {
    if (!state?.running) return;
    const t = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(t);
  }, [state?.running, refresh]);

  // History: the saved days for the rail, and the version open read-only (null = the live brief).
  const [history, setHistory] = useState<TodayHistoryEntry[]>([]);
  const [viewing, setViewing] = useState<{ key: string; brief: TodayBrief; marks: TodayMarks } | null>(null);
  const [peek, setPeek] = useState(false);
  const liveDate = state?.brief?.date ?? null;
  // Reload once a run finishes (a ready brief has a new generatedAt); the gathering saves in between don't add days.
  const liveReadyAt = state?.brief?.status === "ready" ? state.brief.generatedAt : null;
  useEffect(() => {
    let alive = true;
    todayClient.history(workspaceId).then((h) => { if (alive) setHistory(h); }).catch(() => { /* no rail */ });
    return () => { alive = false; };
  }, [workspaceId, liveReadyAt, historyTick]);
  const days = useMemo(() => groupTodayHistory(history), [history]);
  // Newest first; ← steps back through every saved version, → forward to the live brief.
  const order = useMemo(() => days.flatMap((d) => [d.latest, ...d.versions].map((e) => e.key)), [days]);

  // Only the latest pick lands: a slow snapshot can't reopen a day after you've moved on.
  const selectSeq = useRef(0);
  const select = useCallback(async (key: string | null) => {
    const seq = ++selectSeq.current;
    if (key === null || key === liveDate) { setViewing(null); return; }
    const snap = await todayClient.snapshot(workspaceId, key).catch(() => null);
    if (seq !== selectSeq.current) return;
    if (snap) setViewing({ key, ...snap });
    else setHistory((h) => h.filter((e) => e.key !== key)); // pruned since the list was read
  }, [workspaceId, liveDate]);

  useEffect(() => {
    if (order.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      // Keys that belong to a field or a widget stay there (chat composer, menus, lists, tabs, sliders).
      if (t?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox'], [role='tablist'], [role='slider'], [role='grid'], [role='tree']")) return;
      const at = viewing ? Math.max(0, order.indexOf(viewing.key)) : 0;
      if (e.key === "Escape" && viewing) void select(null);
      else if (e.key === "ArrowLeft" && at < order.length - 1) void select(order[at + 1]);
      else if (e.key === "ArrowRight" && at > 0) void select(order[at - 1]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, viewing, select]);

  const comparison = useMemo(
    () => (viewing ? compareTodayBriefs(viewing.brief, viewing.marks, state?.brief ?? null, state?.marks ?? EMPTY_TODAY_MARKS) : null),
    [viewing, state?.brief, state?.marks],
  );

  // `rebuild` looks back the full window instead of only since the last run.
  const run = async (rebuild = false) => {
    selectSeq.current++; // a day still loading from the rail doesn't reopen over the refresh
    setViewing(null);
    setState((s) => (s ? { ...s, running: true } : s));
    setLiveTool({ tool: null });
    try { await todayClient.run(workspaceId, rebuild); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    void refresh();
  };

  if (!state) {
    return <div className="flex justify-center py-16">{error ? <p className="text-sm text-[var(--danger)]">{error}</p> : <MiniStack size={28} busy label="Loading Today" />}</div>;
  }

  if (!state.enabled) {
    return (
      <TodaySetup
        state={state}
        onEnable={async (time, weekdaysOnly, runNow) => {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          setState(await todayClient.enable({ workspaceId, time, weekdaysOnly, timezone: tz }));
          if (runNow) await run();
        }}
      />
    );
  }

  const viewingDay = viewing ? days.find((d) => d.date === viewing.brief.date) : undefined;
  // Where the shown brief sits among the saved versions (0 = the live one), and how many are behind it.
  const stackIndex = viewing ? Math.max(0, order.indexOf(viewing.key)) : 0;
  const stack = order.length >= 2 ? { index: stackIndex, behind: Math.min(3, order.length - 1 - stackIndex) } : null;
  const past: PastView | null = viewing && comparison ? {
    key: viewing.key,
    comparison,
    hasLive: !!state.brief,
    versions: viewingDay ? [viewingDay.latest, ...viewingDay.versions] : [],
    onPick: (key) => void select(key),
    onBack: () => void select(null),
  } : null;
  const view = (
    <BriefView
      state={viewing ? { ...state, brief: viewing.brief, marks: viewing.marks, running: false, activity: null, lastError: null } : state}
      workspaceId={workspaceId}
      liveTool={viewing ? null : liveTool}
      error={viewing ? null : (error ?? saveError)}
      past={past}
      peek={peek}
      stack={stack}
      onRun={run}
      onSchedule={async (time, weekdaysOnly) => {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setState(await todayClient.enable({ workspaceId, time, weekdaysOnly, timezone: tz }));
      }}
      onSettings={async (settings) => setState(await todayClient.settings(workspaceId, settings))}
      onDisable={async () => setState(await todayClient.disable(workspaceId))}
      onExport={() => todayClient.export(workspaceId)}
    />
  );
  // The rail appears once there's something to look back at. The brief keeps the same place in the
  // tree either way, so the rail arriving doesn't remount it (and drop its dialogs and animation).
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">{view}</div>
      {order.length >= 2 && <TodayRail days={days} liveDate={liveDate} selectedKey={viewing?.key ?? null} onSelect={(k) => void select(k)} onPeek={setPeek} />}
    </div>
  );
}

/** A saved brief opened from the rail. */
interface PastView {
  key: string;
  comparison: TodayComparison;
  hasLive: boolean;
  versions: TodayHistoryEntry[];
  onPick: (key: string) => void;
  onBack: () => void;
}

/**
 * What the sidebar shows for Today: whether it's on, whether a run is
 * gathering, and whether the latest brief hasn't been opened yet.
 */
export function useTodayBadge(workspaceId: string | null) {
  const [badge, setBadge] = useState<{ enabled: boolean; running: boolean; unseen: boolean; automationId: string | null }>(
    { enabled: false, running: false, unseen: false, automationId: null },
  );
  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const st = await todayClient.get(workspaceId);
      const gen = st.brief?.status === "ready" ? st.brief.generatedAt : undefined;
      setBadge({ enabled: st.enabled, running: st.running, unseen: !!gen && todaySeenAt(workspaceId) !== gen, automationId: st.automationId });
    } catch { /* off-Electron or no workspace: no badge */ }
  }, [workspaceId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the badge from the main process
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onSeen = () => void load();
    window.addEventListener(TODAY_SEEN_EVENT, onSeen);
    const offRun = automationsClient.onRunEvent((ev) => {
      if (!badge.automationId || ev.automationId !== badge.automationId) return;
      if (ev.event === "started") setBadge((b) => ({ ...b, running: true }));
      if (ev.event === "finished") window.setTimeout(() => void load(), 600);
    });
    // Only the finish changes the badge; the gathering updates in between don't.
    const offUpdate = todayClient.onUpdated((ev) => { if (ev.workspaceId === workspaceId && ev.status === "ready") void load(); });
    return () => { window.removeEventListener(TODAY_SEEN_EVENT, onSeen); offRun(); offUpdate(); };
  }, [load, badge.automationId, workspaceId]);
  return badge;
}

// ── Setup (Today is off) ────────────────────────────────────────────────────

function TodaySetup({ state, onEnable }: {
  state: TodayState;
  onEnable: (time: string, weekdaysOnly: boolean, runNow: boolean) => Promise<void>;
}) {
  const [time, setTime] = useState(state.time);
  const [weekdaysOnly, setWeekdaysOnly] = useState(state.weekdaysOnly);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const turnOn = async (runNow: boolean) => {
    setBusy(true);
    setFailed(null);
    try { await onEnable(time, weekdaysOnly, runNow); } catch (e) { setFailed(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const connectors = state.apps;

  return (
    <div className="max-w-[640px] mx-auto py-10">
      <CairnStack counts={{ need: 3, prep: 2, fyi: 4 }} className="mb-6" />
      <h2 className="text-lg font-semibold">Start each day with Today</h2>
      <p className="text-sm text-[var(--text-secondary)] mt-2 leading-relaxed">
        Each morning Cairn reads the boards of your {state.projects.length === 1 ? "project" : `${state.projects.length} projects`} and
        your connected apps, then sorts what it finds into what needs you, what it has already drafted for you, and what is moving
        without you. It only reads: nothing is sent, posted or changed until you act on it.
      </p>

      <div className="mt-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-elev-1 p-4 space-y-4">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-[var(--text-secondary)] w-24">Refresh at</span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value || "07:00")}
            className="h-7 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 text-sm text-[var(--text-primary)]"
          />
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Toggle checked={weekdaysOnly} onCheckedChange={setWeekdaysOnly} label="Weekdays only" />
            Weekdays only
          </label>
        </div>
        <div className="text-sm">
          <span className="text-[var(--text-secondary)]">Connected apps it will read</span>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <SourceChip name="Board, notes and automations" ok />
            {connectors.map((c) => <SourceChip key={c.id} name={c.name} ok />)}
            {connectors.length === 0 && (
              <span className="text-xs text-[var(--text-tertiary)]">No connectors yet. Add Slack, Work IQ, GitHub or Atlassian in Settings → Tools.</span>
            )}
          </div>
          <p className="text-2xs text-[var(--text-tertiary)] mt-2">
            Uses the connectors attached to your projects or to all projects. You can leave projects and apps out later. Gathered content is sent to your configured model.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-5">
        <Button variant="accent" disabled={busy} onClick={() => void turnOn(true)}>
          <Play size={12} /> Turn on and run now
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void turnOn(false)}>
          Turn on
        </Button>
      </div>
      {failed && <p className="text-xs text-[var(--danger)] mt-3">Couldn&apos;t turn Today on: {failed}</p>}
      <p className="text-2xs text-[var(--text-tertiary)] mt-3">It also appears in Automations as &ldquo;Today&rdquo;, with its run history.</p>
    </div>
  );
}

// ── The brief ───────────────────────────────────────────────────────────────

function BriefView({ state, workspaceId, liveTool, error, past, peek, stack, onRun, onSchedule, onSettings, onDisable, onExport }: {
  state: TodayState;
  workspaceId: string;
  liveTool: TodayRunActivity | null;
  error: string | null;
  /** Set when this is a saved brief opened from the rail: read-only, with a banner instead of the controls. */
  past: PastView | null;
  /** The rail is hovered: the stack of earlier briefs fans out a little. */
  peek: boolean;
  /** With saved history: where this brief sits (0 = live) and how many earlier ones are stacked behind it. */
  stack: { index: number; behind: number } | null;
  onRun: (rebuild?: boolean) => void;
  onSchedule: (time: string, weekdaysOnly: boolean) => Promise<void>;
  onSettings: (settings: TodaySettingsValue) => Promise<void>;
  onDisable: () => Promise<void>;
  onExport: () => Promise<{ filePath: string } | null>;
}) {
  const brief = state.brief;
  const projectNames = useMemo(() => new Map(state.projects.map((p) => [p.id, p.name])), [state.projects]);
  const activeProjectId = useCairnStore((s) => s.activeProjectId);
  const gathering = state.running && brief?.status === "gathering";
  const readOnly = !!past;
  // Changing day moves the card: an earlier brief rises from the stack, a newer one drops in from the front.
  const cardRef = useRef<HTMLDivElement>(null);
  const shownIndex = stack?.index ?? 0;
  const lastIndex = useRef(shownIndex);
  useEffect(() => {
    const from = lastIndex.current;
    lastIndex.current = shownIndex;
    const el = cardRef.current;
    if (from === shownIndex || !el || typeof el.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const older = shownIndex > from;
    el.animate(
      older
        ? [{ transform: "translateY(-22px) scale(0.955)", opacity: 0.35 }, { transform: "none", opacity: 1 }]
        : [{ transform: "translateY(18px) scale(1.012)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 340, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }, [shownIndex]);
  const connectors = useCommunityConnectorMap();
  const runStep = (tool: string, args?: Record<string, unknown>, label?: string) => {
    const c = connectorForTool(tool, connectors);
    return humanizedRunStep(tool, args, c?.label || c?.name, label);
  };
  const { ids: marked, toggle, set: setDismissed, edits, setEdit } = useMarks(workspaceId, brief?.date, state.marks, readOnly);
  // Looking back, what's been resolved since reads as done too.
  const resolved = past?.comparison.resolved;
  const dismissed = useMemo(() => (resolved ? new Set([...marked, ...resolved]) : marked), [marked, resolved]);
  // The item open in the act panel; `doneId` is what "done" marks in Today.
  const [act, setAct] = useState<(TodayActTarget & { doneId: string }) | null>(null);
  // A brief the user hasn't opened yet stacks itself in once, then counts as seen.
  // Captured once per mount: a brief that lands while the view is open differs from it too.
  const [seenAtMount] = useState(() => todaySeenAt(workspaceId));
  const unseen = !readOnly && !!brief && brief.status === "ready" && seenAtMount !== brief.generatedAt;
  useEffect(() => { if (!readOnly && brief?.status === "ready") markTodaySeen(workspaceId, brief.generatedAt); }, [workspaceId, brief, readOnly]);
  const [flash, setFlash] = useState<Lane | "day" | null>(null);
  const [showAllDrafts, setShowAllDrafts] = useState(false);
  const nowMs = useNow(60_000);
  const jump = (lane: Lane | "day") => {
    const el = document.getElementById(`today-lane-${lane === "focus" ? "need" : lane}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(lane);
    window.setTimeout(() => setFlash(null), 1100);
  };

  const now = new Date(nowMs);
  const isToday = brief ? brief.date === localDate(now) : false;
  // A brief from an earlier day has no "now": nothing in it reads as past.
  const nowMin = isToday ? now.getHours() * 60 + now.getMinutes() : 0;
  const events = brief?.events;
  const day = useMemo(() => dayBlocks(events ?? [], nowMin), [events, nowMin]);

  const header = (
    <div className="flex flex-wrap items-center gap-2 mt-4">
      <Button variant="accent" size="sm" onClick={() => onRun()} disabled={state.running}>
        {state.running ? <MiniStack size={13} busy /> : <RefreshCw size={12} />} {state.running ? "Gathering" : brief ? "Refresh" : "Run now"}
      </Button>
      <TodaySettings key={`${state.time}-${state.weekdaysOnly}`} state={state} onSchedule={onSchedule} onSettings={onSettings} onDisable={onDisable} onExport={onExport} onRebuild={() => onRun(true)} />
      {brief?.note && !state.running && <RunNote note={brief.note} at={brief.generatedAt} />}
      <span className="text-2xs text-[var(--text-tertiary)] ml-1">
        {state.running ? (liveTool?.tool ? runStep(liveTool.tool, liveTool.args, liveTool.label) : "Starting the run") : (
          <>
            {brief ? `Updated ${formatRelative(brief.generatedAt)}` : "Not run yet"}
            {state.nextRunAt ? ` · next run ${new Date(state.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
          </>
        )}
      </span>
    </div>
  );

  if (!brief) {
    return (
      <div className="max-w-[640px] mx-auto py-12">
        <CairnStack counts={{ need: 0, prep: 0, fyi: 0 }} muted={!state.running} busy={state.running} className="mb-6" />
        <h2 className="text-lg font-semibold">{state.running ? "Writing your first brief" : "No brief yet"}</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-2">
          {state.running ? "Cairn is reading your boards and connected apps. Items appear here as it finds them." : "Today is on. Run it now or wait for the next scheduled run."}
        </p>
        {(state.lastError || error) && <p className="text-xs text-[var(--danger)] mt-3">{error ?? state.lastError}</p>}
        {header}
      </div>
    );
  }

  const needYou = brief.needYou;
  const focus = needYou.find((n) => n.id === brief.focusId) ?? needYou[0];
  const openNeed = needYou.filter((n) => !dismissed.has(n.id));
  const openDecisions = openNeed.filter((n) => n.kind === "decision").length;
  const linked = linkedDraftIds(brief);
  // Drafts as the user left them: an edit replaces Cairn's text everywhere it's used.
  const prepared = brief.prepared.map((p) => (edits[p.id] !== undefined ? { ...p, draft: edits[p.id] } : p));
  const openDrafts = prepared.filter((p) => !dismissed.has(p.id));
  const openLinked = openDrafts.filter((p) => linked.has(p.id)).length;
  // Drafts that answer a decision sit on its choices, so the lane lists only the rest.
  const lanePrepared = showAllDrafts ? prepared : prepared.filter((p) => !linked.has(p.id));
  const openPrep = lanePrepared.filter((p) => !dismissed.has(p.id)).length;
  const draftFor = (id?: string) => prepared.find((p) => p.id === id);
  const original = (id: string) => brief.prepared.find((p) => p.id === id)?.draft ?? "";
  const best = day.blocks.find((b) => b.best);
  const bestLabel = best ? `${formatClock(best.start)}–${formatClock(best.end)}` : null;
  const d = new Date(brief.generatedAt);
  const hasDay = brief.events.length > 0;

  return (
    <ProjectNames.Provider value={projectNames}>
    <div className="pb-6">
      {past && (
        <TodayPastBanner
          date={brief.date}
          generatedAt={brief.generatedAt}
          versions={past.versions}
          selectedKey={past.key}
          comparison={past.comparison}
          hasLive={past.hasLive}
          onPick={past.onPick}
          onBack={past.onBack}
        />
      )}
      {/* The brief is the front card; one edge shows above it for each earlier brief (up to three). */}
      <div className={cn("relative isolate", stack && "pt-7")}>
      {stack && [0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden
          className="absolute inset-x-0 bottom-0 top-7 -z-10 origin-top rounded-2xl border border-[var(--border-subtle)] pointer-events-none transition-[transform,opacity] duration-300 ease-out"
          style={{
            background: "color-mix(in srgb, var(--surface) 40%, var(--background))",
            opacity: i < stack.behind ? [0.95, 0.65, 0.4][i] : 0,
            transform: `translateY(${(peek ? [-11, -20, -27] : [-7, -13, -18])[i]}px) scale(${[0.975, 0.95, 0.925][i]})`,
          }}
        />
      ))}
      <div
        ref={cardRef}
        className={cn(
          "grid gap-8 items-end grid-cols-1 @3xl:grid-cols-[1fr_300px]",
          stack
            ? "rounded-2xl border border-[var(--border-subtle)] shadow-elev-1 px-5 pt-4 pb-5"
            : "pb-5 border-b border-[var(--border-subtle)]",
        )}
        style={stack ? { background: "color-mix(in srgb, var(--surface) 60%, var(--background))" } : undefined}
      >
        <div className="min-w-0">
          <div className="text-xs text-[var(--text-tertiary)]">
            {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
            {isToday && !past && ` · ${formatClock(nowMin)}`}
            {!isToday && !past && <span className="text-[var(--warning)] font-sans"> · from an earlier day</span>}
            {past && ` · ${formatClock(d.getHours() * 60 + d.getMinutes())}`}
          </div>
          <h2 className="text-2xl leading-tight mt-2 mb-1.5 max-w-[24ch] font-normal tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {gathering ? "Gathering your brief" : brief.headline}
          </h2>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-[58ch]">
            {gathering
              ? "Items arrive as Cairn finds them, and the headline comes last."
              : brief.lede}
          </p>
          {(state.lastError || error) && <p className="text-xs text-[var(--danger)] mt-2">Last run: {error ?? state.lastError}</p>}
          <div className="grid gap-2.5 mt-4 grid-cols-2 @xl:grid-cols-[repeat(4,minmax(0,150px))]">
            <KpiTile label="Decisions" value={String(openDecisions)} detail={`of ${openNeed.length} that need you`} onClick={() => jump("need")} />
            <KpiTile
              label="Drafts ready"
              value={String(openDrafts.length)}
              detail={openLinked ? `${openLinked} on decisions · nothing sent` : "nothing sent"}
              onClick={() => jump(openLinked === openDrafts.length && openLinked > 0 ? "need" : "prep")}
            />
            {hasDay && (
              <>
                <KpiTile
                  label={isToday ? "Free time left" : "Free time"}
                  value={formatMinutes(day.freeLeft)}
                  detail={day.largestFree ? `largest ${formatMinutes(day.largestFree)}` : "no free block left"}
                  onClick={() => jump("day")}
                />
                <KpiTile
                  label={isToday ? "Meetings left" : "Meetings"}
                  value={String(day.meetingsLeft)}
                  detail={day.nextMeeting ? `${day.nextMeeting.title} · ${day.nextMeeting.start}` : "none left today"}
                  onClick={() => jump("day")}
                />
              </>
            )}
          </div>
          {!past && header}
        </div>
        <div className="flex items-end gap-4">
          <CairnStack
            key={brief.generatedAt}
            counts={{ need: openNeed.length, prep: openPrep, fyi: brief.fyi.length }}
            onPick={jump}
            busy={state.running}
            drop={unseen}
          />
          <div className="flex flex-col text-xs min-w-0">
            {focus && <LegendRow n={1} label="Focus" hint={focus.title} accent onClick={() => jump("focus")} />}
            <LegendRow n={openNeed.length} label="Need you" onClick={() => jump("need")} />
            <LegendRow n={openPrep} label="Prepared for you" onClick={() => jump("prep")} />
            <LegendRow n={brief.fyi.length} label="Moving without you" onClick={() => jump("fyi")} />
          </div>
        </div>
      </div>
      </div>

      {hasDay && (
        <DayStrip
          day={day}
          nowMin={isToday ? nowMin : null}
          focusTitle={focus && !dismissed.has(focus.id) ? focus.title : undefined}
          flash={flash === "day"}
        />
      )}

      <div className="grid gap-3.5 mt-6 items-start grid-cols-1 @4xl:grid-cols-[1.2fr_1fr_0.85fr]">
        <LaneBox id="need" title="Need you" count={openNeed.length} tone="var(--stone-3)" flash={flash === "need" || flash === "focus"}>
          {needYou.length === 0 && <Empty>Nothing is waiting on you.</Empty>}
          {needYou.map((n) => (
            <NeedCard
              key={n.id}
              item={n}
              focus={n.id === focus?.id}
              done={dismissed.has(n.id)}
              draftFor={draftFor}
              onToggle={() => toggle(n.id)}
              onAct={(t) => { if (!readOnly) setAct({ ...t, doneId: n.id }); }}
              edited={(id) => edits[id] !== undefined}
              onEdit={setEdit}
              original={original}
            />
          ))}
        </LaneBox>
        <LaneBox id="prep" title="Prepared for you" count={openPrep} tone="var(--stone-2)" note="Nothing sent" flash={flash === "prep"}>
          {lanePrepared.length === 0 && (
            <Empty>{linked.size ? "Every draft answers a decision, so each one sits on that decision's choices." : "No drafts this time."}</Empty>
          )}
          {lanePrepared.map((p) => (
            <DraftCard
              key={p.id}
              item={p}
              done={dismissed.has(p.id)}
              onDismiss={() => toggle(p.id)}
              onAct={(t) => { if (!readOnly) setAct({ ...t, doneId: p.id }); }}
              slot={p.kind !== "reply" ? bestLabel : null}
              edited={edits[p.id] !== undefined}
              onEdit={(text) => setEdit(p.id, text === original(p.id) ? null : text)}
            />
          ))}
          {linked.size > 0 && (
            <p className="text-2xs text-[var(--text-tertiary)] leading-relaxed px-1 pt-0.5">
              {showAllDrafts
                ? "Showing every draft, including the ones on decisions. "
                : "Replies that answer a decision sit on that decision's choices, so they aren't listed twice. "}
              <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setShowAllDrafts((v) => !v)}>
                {showAllDrafts ? "Hide them" : `Show all ${brief.prepared.length} drafts`}
              </button>
            </p>
          )}
        </LaneBox>
        <LaneBox id="fyi" title="Moving without you" count={brief.fyi.length} tone="var(--stone-1)" flash={flash === "fyi"}>
          {brief.fyi.length === 0 && <Empty>Quiet.</Empty>}
          {brief.fyi.map((f) => <FyiRow key={f.id} item={f} />)}
        </LaneBox>
      </div>

      {/* Project facts are worked out now, so they don't belong to an earlier brief. */}
      {!past && <ProjectsSection facts={state.facts} />}

      <div className="mt-6 flex flex-wrap items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-[var(--border-subtle)] text-xs">
        <span className="text-2xs text-[var(--text-tertiary)] mr-1">Built from</span>
        {brief.sources.length === 0 && <SourceChip name="Board and notes" ok />}
        {brief.sources.map((s) => (
          <SourceChip key={s.name} name={`${s.name}${typeof s.items === "number" ? ` · ${s.items}` : ""}`} ok={s.status === "ok"} warn={s.status === "error"} hint={s.note} />
        ))}
        {brief.gap && <p className="basis-full text-2xs text-[var(--text-tertiary)] mt-1">{brief.gap}</p>}
      </div>

      {act && (
        <TodayActPanel
          key={`${act.key}-${act.answer ?? ""}`}
          workspaceId={workspaceId}
          projectId={act.projectId ?? activeProjectId ?? undefined}
          date={brief.date}
          target={act}
          done={dismissed.has(act.doneId)}
          cairnDraft={act.draft ? original(act.draft.id) : undefined}
          onSaveDraft={(id, text) => setEdit(id, text === null || text === original(id) ? null : text)}
          onDone={() => setDismissed(act.doneId, true)}
          onUndoDone={() => setDismissed(act.doneId, false)}
          onClose={() => setAct(null)}
        />
      )}
    </div>
    </ProjectNames.Provider>
  );
}

/** The run's closing message (what it did, what failed), behind a button so the brief stays one page. */
function RunNote({ note, at }: { note: string; at: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog"><NotebookText size={12} /> Run notes</Button>
      <ModalShell
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        scrollable
        title={<span className="flex items-center gap-2"><NotebookText size={14} className="text-[var(--text-tertiary)]" /> Run notes</span>}
        subtitle={`What Cairn said when it finished, ${formatRelative(at)}`}
      >
        <div className="text-sm text-[var(--text-secondary)]"><MarkdownContent content={note} /></div>
      </ModalShell>
    </>
  );
}

function TodaySettings({ state, onSchedule, onSettings, onDisable, onExport, onRebuild }: {
  state: TodayState;
  onSchedule: (time: string, weekdaysOnly: boolean) => Promise<void>;
  onSettings: (settings: TodaySettingsValue) => Promise<void>;
  onDisable: () => Promise<void>;
  onExport: () => Promise<{ filePath: string } | null>;
  onRebuild: () => void;
}) {
  const flip = (list: string[], id: string, on: boolean) => (on ? list.filter((x) => x !== id) : [...list, id]);
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(state.time);
  const [weekdaysOnly, setWeekdaysOnly] = useState(state.weekdaysOnly);
  const [exported, setExported] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const attempt = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    try { await fn(); setFailed(null); return true; } catch (e) { setFailed(`${what}: ${e instanceof Error ? e.message : String(e)}`); return false; }
  };
  // Toggles apply one at a time, each to the settings the last one left, so a quick second click
  // doesn't overwrite the first with a stale list.
  const latest = useRef(state.settings);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  useEffect(() => { if (pending.current === 0) latest.current = state.settings; }, [state.settings]);
  const change = (what: string, edit: (s: TodaySettingsValue) => TodaySettingsValue) => {
    pending.current += 1;
    queue.current = queue.current.then(async () => {
      const before = latest.current;
      const next = edit(before);
      latest.current = next;
      if (!(await attempt(what, () => onSettings(next)))) latest.current = before;
      pending.current -= 1;
    });
  };
  const scheduleChanged = time !== state.time || weekdaysOnly !== state.weekdaysOnly;
  const close = () => { setOpen(false); setFailed(null); setTime(state.time); setWeekdaysOnly(state.weekdaysOnly); };
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog"><Settings2 size={12} /> Settings</Button>
      <ModalShell
        open={open}
        onClose={close}
        size="md"
        scrollable
        title={<span className="flex items-center gap-2"><Settings2 size={14} className="text-[var(--text-tertiary)]" /> Today settings</span>}
        subtitle="One brief for this workspace"
        footer={
          <>
            <Button variant="ghost" size="sm" className="mr-auto text-[var(--danger)]" onClick={async () => { if (await attempt("Couldn't turn Today off", onDisable)) setOpen(false); }}>Turn off Today</Button>
            <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
            <Button variant="accent" size="sm" onClick={async () => { if (!scheduleChanged || await attempt("Couldn't save the schedule", () => onSchedule(time, weekdaysOnly))) close(); }}>
              <Check size={11} className="mr-1" /> Save
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {failed && <p role="alert" className="text-xs text-[var(--danger)]">{failed}</p>}
          <div>
            <label className="text-sm text-[var(--text-tertiary)] block mb-1.5" htmlFor="today-time">Schedule</label>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <input
                id="today-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value || "07:00")}
                className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 text-sm text-[var(--text-primary)]"
              />
              <label className="flex items-center gap-2 text-[var(--text-secondary)]">
                <Toggle checked={weekdaysOnly} onCheckedChange={setWeekdaysOnly} label="Weekdays only" /> Weekdays only
              </label>
              {state.nextRunAt && (
                <span className="ml-auto text-2xs text-[var(--text-tertiary)]">
                  Next run {new Date(state.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          </div>
          <SettingsList
            title="Projects"
            hint="Today reads the board of each project that's on, and the apps attached to it. Changes apply straight away."
            items={state.projects.map((p) => ({ id: p.id, name: p.name, on: !state.settings.excludedProjects.includes(p.id) }))}
            onToggle={(id, on) => change("Couldn't change the projects", (s) => ({ ...s, excludedProjects: flip(s.excludedProjects, id, on) }))}
          />
          <SettingsList
            title="Apps"
            hint="Apps that are off aren't offered to the run at all."
            empty="No apps are attached to the projects that are on."
            items={state.apps.map((a) => ({ id: a.id, name: a.name, on: !state.settings.excludedApps.includes(a.id) }))}
            onToggle={(id, on) => change("Couldn't change the apps", (s) => ({ ...s, excludedApps: flip(s.excludedApps, id, on) }))}
          />
          <div className="border-t border-[var(--border-subtle)] pt-4 space-y-4">
            <SettingsAction
              title="Rebuild brief"
              hint={state.running ? "A run is gathering now." : "Looks back 24 hours (72 on a Monday) instead of only since the last run, to find what earlier runs missed. Items you marked done stay done."}
            >
              <Button size="sm" variant="outline" disabled={state.running} onClick={() => { onRebuild(); setOpen(false); }}>
                <RotateCcw size={12} /> Rebuild
              </Button>
            </SettingsAction>
            <SettingsAction
              title="Export data"
              hint={exported ?? "The last run's settings, prompt, steps and the content Cairn read, as one JSON file, for debugging."}
              breakAll={!!exported}
            >
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    const r = await onExport();
                    if (r) setExported(r.filePath);
                  } catch (e) { setExported(`Export failed: ${e instanceof Error ? e.message : String(e)}`); }
                }}
              >
                <Download size={12} /> Export
              </Button>
            </SettingsAction>
          </div>
        </div>
      </ModalShell>
    </>
  );
}

/** A settings row with a title and one line on the left, its button on the right. */
function SettingsAction({ title, hint, breakAll, children }: { title: string; hint: string; breakAll?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-[var(--text-tertiary)]">{title}</div>
        <p className={cn("text-2xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed", breakAll && "break-all")}>{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SettingsList({ title, hint, empty, items, onToggle }: {
  title: string; hint: string; empty?: string;
  items: Array<{ id: string; name: string; on: boolean }>;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div>
      <div className="text-sm text-[var(--text-tertiary)]">{title}</div>
      <p className="text-2xs text-[var(--text-tertiary)] mt-0.5 mb-2 leading-relaxed">{hint}</p>
      {items.length === 0 && empty && <p className="text-2xs text-[var(--text-tertiary)]">{empty}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
        {items.map((it) => (
          <label key={it.id} className="flex items-center gap-2 text-xs text-[var(--text-secondary)] min-w-0">
            <Toggle checked={it.on} onCheckedChange={(on) => onToggle(it.id, on)} label={it.name} />
            <span className="truncate">{it.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Your projects (computed by Cairn) ───────────────────────────────────────

function ProjectsSection({ facts }: { facts: TodayProjectFacts[] }) {
  const { setActiveProject, setView } = useCairnStore(useShallow((s) => ({ setActiveProject: s.setActiveProject, setView: s.setView })));
  if (facts.length === 0) return null;
  const open = (projectId: string) => { setActiveProject(projectId); setView("board"); };
  return (
    <section className="mt-6">
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <h3 className="text-sm font-semibold">Your projects</h3>
        <span className="text-2xs text-[var(--text-tertiary)]">From your boards, notes and automations, worked out by Cairn</span>
      </div>
      <div className="grid gap-2.5 grid-cols-1 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {facts.map((f) => {
          // Card lists stop at a few; the count is the full one.
          const chips: Array<{ label: string; list: string[]; count?: number; warn?: boolean }> = [
            { label: "due today", list: f.dueToday.map((c) => c.title), count: f.counts?.dueToday },
            { label: "overdue", list: f.overdue.map((c) => `${c.title} · due ${c.dueDate}`), count: f.counts?.overdue, warn: true },
            { label: "in review", list: f.inReview.map((c) => c.title), count: f.counts?.inReview },
            { label: "stale 5d+", list: f.stale.map((c) => `${c.title} · ${c.days}d`), count: f.counts?.stale },
            { label: f.failingAutomations.length === 1 ? "automation failing" : "automations failing", list: f.failingAutomations.map((a) => `${a.name} · ${a.failures} failed`), warn: true },
            { label: f.notesChanged.length === 1 ? "note changed" : "notes changed", list: f.notesChanged.map((n) => n.title) },
          ].filter((c) => c.list.length > 0);
          return (
            <div key={f.projectId} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-elev-1 px-3 py-2.5 min-w-0">
              <button type="button" onClick={() => open(f.projectId)} className={cn("text-sm font-medium hover:text-[var(--accent)] truncate max-w-full text-left rounded", FOCUS_RING)}>
                {f.name}
              </button>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {chips.length === 0 && <span className="text-2xs text-[var(--text-tertiary)]">Nothing due, in review or stale.</span>}
                {chips.map((c) => (
                  <Tooltip key={c.label} content={<span className="block max-w-[260px] whitespace-pre-line">{[...c.list, ...((c.count ?? 0) > c.list.length ? [`and ${c.count! - c.list.length} more`] : [])].join("\n")}</span>}>
                    <span
                      tabIndex={0}
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-2xs",
                        c.warn ? "border-[color-mix(in_srgb,var(--warning)_45%,transparent)] text-[var(--text-primary)]" : "border-[var(--border)] text-[var(--text-secondary)]",
                      )}
                    >
                      <span className="font-mono font-semibold">{c.count ?? c.list.length}</span> {c.label}
                    </span>
                  </Tooltip>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function LegendRow({ n, label, hint, accent, onClick }: { n: number; label: string; hint?: string; accent?: boolean; onClick: () => void }) {
  return (
    <Tooltip content={hint ?? `Jump to ${label}`} side="left">
    <button
      type="button"
      onClick={onClick}
      className="grid grid-cols-[24px_1fr] items-center text-left px-1.5 py-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] min-w-0"
    >
      <span className={cn("font-mono font-semibold", accent ? "text-[var(--accent)]" : "text-[var(--text-primary)]")}>{n}</span>
      <span className={cn("truncate", accent && "text-[var(--text-primary)]")}>{label}</span>
    </button>
    </Tooltip>
  );
}

function KpiTile({ label, value, detail, onClick }: { label: string; value: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-left rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface)] shadow-elev-1 px-3 py-2 min-w-0 hover:bg-[var(--surface-2)]",
        FOCUS_RING,
      )}
    >
      <span className="block text-2xs text-[var(--text-tertiary)]">{label}</span>
      <span className="block text-lg font-semibold leading-tight mt-0.5">{value}</span>
      <span className="block text-2xs text-[var(--text-secondary)] mt-0.5 truncate">{detail}</span>
    </button>
  );
}

const DAY_START = 7 * 60;
const DAY_END = 19 * 60;
const dayPct = (m: number) => ((Math.max(DAY_START, Math.min(DAY_END, m)) - DAY_START) / (DAY_END - DAY_START)) * 100;
const freeFill = (best?: boolean) => `color-mix(in srgb, var(--accent) ${best ? 38 : 22}%, var(--surface))`;

let measureCtx: CanvasRenderingContext2D | null = null;
/** Width of `text` in px at the strip's label size, so a label only goes inside a block it fits. */
function labelWidth(text: string, px: number): number {
  if (typeof document === "undefined") return Infinity;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return Infinity;
  measureCtx.font = `${px}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(text).width;
}

/**
 * The working day with free time as the point: free blocks in the accent
 * (the best one stronger), meetings in stone, the past dimmed. Labels go
 * inside a block only when they fit; the tooltip and the agenda list below
 * carry everything else.
 */
function DayStrip({ day, nowMin, focusTitle, flash }: { day: TodayDay; nowMin: number | null; focusTitle?: string; flash?: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const { width } = useContainerDims(trackRef);
  const labelPx = 9 * useFontScale();
  const best = day.blocks.find((b) => b.best);
  const ticks = Array.from({ length: 7 }, (_, i) => DAY_START + i * 120);
  const showNow = nowMin !== null && nowMin > DAY_START && nowMin < DAY_END;
  const visible = day.blocks.filter((b) => b.end > DAY_START && b.start < DAY_END);
  const agenda = day.blocks.filter((b) => !(b.kind === "free" && b.past));

  return (
    <section id="today-lane-day" className="mt-5">
      <div className="flex items-baseline gap-2.5 mb-2">
        <h3 className="text-sm font-semibold">Your day</h3>
        <span className="text-2xs text-[var(--text-tertiary)]">07:00–19:00 · hover a block for details</span>
      </div>
      <div
        className={cn(
          "rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-elev-1 px-4 pt-3.5 pb-2.5 transition-[outline]",
          flash && "outline outline-2 outline-offset-2 outline-[color-mix(in_srgb,var(--accent)_60%,transparent)]",
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
          <span className="text-base font-semibold">{formatMinutes(day.freeLeft)} free</span>
          <span className="text-xs text-[var(--text-tertiary)]">
            {nowMin !== null ? "left today" : "in the day"}, in {day.freeBlocksLeft} {day.freeBlocksLeft === 1 ? "block" : "blocks"}
          </span>
          {best && (
            <span className="ml-auto text-xs text-[var(--text-secondary)] min-w-0 truncate">
              Best slot for focus: <b className="font-medium text-[var(--text-primary)]">{formatClock(best.start)}–{formatClock(best.end)}</b>
              {focusTitle && <> · fits &ldquo;{focusTitle}&rdquo;</>}
            </span>
          )}
        </div>

        <div className="relative h-3.5 mb-1">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 font-mono text-2xs text-[var(--text-tertiary)]" style={{ left: `${dayPct(t)}%` }}>
              {String(t / 60).padStart(2, "0")}
            </span>
          ))}
        </div>
        <div ref={trackRef} className="relative h-7">
          {ticks.map((t) => (
            <i key={t} className="absolute top-0 bottom-0 w-px bg-[var(--border-subtle)] pointer-events-none" style={{ left: `${dayPct(t)}%` }} />
          ))}
          {visible.map((b, bi) => {
            const left = dayPct(b.start);
            const w = dayPct(b.end) - left;
            const mins = b.end - b.start;
            const free = b.kind === "free";
            const label = free ? (b.past ? "" : `Free ${formatMinutes(mins)}`) : b.event?.title ?? "";
            const fits = !!label && labelWidth(label, labelPx) + 14 <= (w / 100) * width - 2;
            const title = free ? (b.past ? "Free time (past)" : b.best ? "Free · best slot for focus" : "Free") : b.event?.title;
            const sub = [`${formatClock(b.start)}–${formatClock(b.end)}`, formatMinutes(mins), b.event?.location, b.event?.note].filter(Boolean).join(" · ");
            return (
              <Tooltip
                key={`${b.kind}-${b.start}-${b.event?.id ?? bi}`}
                content={<span className="block max-w-[260px]"><b className="block font-semibold">{title}</b>{sub}</span>}
              >
                <button
                  type="button"
                  onClick={() => openUrl(b.event?.url)}
                  aria-label={`${title}, ${sub}`}
                  className={cn(
                    "absolute top-0 h-7 rounded flex items-center px-[7px] text-2xs whitespace-nowrap overflow-hidden text-[var(--text-primary)] hover:brightness-110",
                    b.past && "opacity-40",
                    !b.event?.url && "cursor-default",
                    FOCUS_RING,
                  )}
                  style={{
                    left: `calc(${left}% + 1px)`,
                    width: `calc(${w}% - 2px)`,
                    background: free ? freeFill(b.best) : "var(--stone-2)",
                    boxShadow: b.event?.note ? "inset 0 0 0 1.5px var(--warning)" : undefined,
                  }}
                >
                  {fits ? label : null}
                </button>
              </Tooltip>
            );
          })}
          {showNow && (
            <div className="absolute -top-1 h-9 w-0.5 rounded-sm bg-[var(--text-primary)] pointer-events-none" style={{ left: `${dayPct(nowMin)}%` }}>
              <span className="absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-2xs bg-[var(--surface)] px-1">{formatClock(nowMin)}</span>
            </div>
          )}
        </div>

        {/* The table view: every block in words, so nothing depends on hover or colour. */}
        <div className="mt-3 border-t border-[var(--border-subtle)] pt-1.5 grid grid-cols-[auto_1fr_auto] gap-x-3.5 text-xs">
          {agenda.map((b, i) => {
            const free = b.kind === "free";
            const cell = cn("py-1.5", i < agenda.length - 1 && "border-b border-[var(--border-subtle)]");
            return (
              <div key={`${b.kind}-${b.start}-${b.event?.id ?? i}`} className="contents">
                <span className={cn(cell, "font-mono text-2xs text-[var(--text-secondary)] whitespace-nowrap", b.past && "opacity-45")}>
                  {formatClock(b.start)}–{formatClock(b.end)}
                </span>
                <span className={cn(cell, "min-w-0 truncate", b.past && "opacity-45")}>
                  <span className="inline-block w-2 h-2 rounded-sm mr-2" style={{ background: free ? freeFill(b.best) : "var(--stone-2)" }} />
                  {free ? `Free ${formatMinutes(b.end - b.start)}` : b.event?.title}
                </span>
                <span className={cn(cell, "text-right")}>
                  {b.best ? <DayTag>Best slot{focusTitle ? ` · ${focusTitle}` : ""}</DayTag>
                    : b.event?.note ? <DayTag warn>⚠ {b.event.note}</DayTag>
                    : b.past ? <DayTag>done</DayTag>
                    : b.event?.location ? <DayTag>{b.event.location}</DayTag> : null}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function DayTag({ warn, children }: { warn?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-block max-w-[240px] truncate align-middle text-2xs rounded px-1.5 py-px",
        warn ? "bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--text-primary)]" : "bg-[var(--surface-3)] text-[var(--text-secondary)]",
      )}
    >
      {children}
    </span>
  );
}

function LaneBox({ id, title, count, tone, note, flash, children }: {
  id: Lane; title: string; count: number; tone: string; note?: string; flash?: boolean; children: React.ReactNode;
}) {
  return (
    <section
      id={`today-lane-${id}`}
      className={cn(
        "rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-elev-1 p-3 transition-[outline]",
        flash && "outline outline-2 outline-offset-2 outline-[color-mix(in_srgb,var(--accent)_60%,transparent)]",
      )}
    >
      <div className="flex items-center gap-2 px-1 pb-2.5">
        <span className="w-3 h-2 rounded-full" style={{ background: tone }} />
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="font-mono text-2xs text-[var(--text-tertiary)] bg-[var(--surface-3)] rounded px-1.5">{count}</span>
        {note && <span className="ml-auto text-2xs text-[var(--text-tertiary)]">{note}</span>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function ProjectChip({ projectId }: { projectId?: string }) {
  const name = useContext(ProjectNames).get(projectId ?? "");
  if (!name) return null;
  return <span className="shrink-0 max-w-[12ch] truncate px-1.5 rounded bg-[var(--surface-3)] text-[var(--text-secondary)]">{name}</span>;
}

/** "Since Mon" on an item still open from an earlier day. */
function CarriedChip({ since }: { since?: string }) {
  if (!since) return null;
  const [y, m, d] = since.split("-").map(Number);
  const first = new Date(y, m - 1, d);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - first.getTime()) / 86_400_000);
  if (days < 1) return null;
  const label = days < 7 ? first.toLocaleDateString(undefined, { weekday: "short" }) : first.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <Tooltip content={`Still open: first in your brief ${days === 1 ? "yesterday" : `${days} days ago`}. Cairn checks it again on each run.`}>
      <span tabIndex={0} className="shrink-0 px-1.5 rounded border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] text-[var(--text-secondary)]">
        since {label}
      </span>
    </Tooltip>
  );
}

function ItemMeta({ kind, source, age, projectId, since, children }: {
  kind: string; source: string; age?: string; projectId?: string; since?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)] mb-1 min-w-0">
      <span className="font-medium text-[var(--text-secondary)] shrink-0">{kind}</span>
      <ProjectChip projectId={projectId} />
      <CarriedChip since={since} />
      <span className="truncate">· {source}</span>
      {age && <span className="ml-auto font-mono shrink-0">{age}</span>}
      {children}
    </div>
  );
}

function NeedCard({ item, focus, done, draftFor, onToggle, onAct, edited, onEdit, original }: {
  item: TodayNeedItem; focus: boolean; done: boolean; draftFor: (id?: string) => TodayPrepared | undefined;
  onToggle: () => void; onAct: (t: TodayActTarget) => void;
  edited: (draftId: string) => boolean; onEdit: (draftId: string, text: string | null) => void; original: (draftId: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const choiceDrafts = item.choices.flatMap((c) => {
    const d = draftFor(c.draftId);
    return d ? [{ choice: c, draft: d }] : [];
  });
  const decision = item.kind === "decision" && item.choices.length > 0;
  const itemDraft = draftFor(item.draftId);
  const base = {
    key: item.id, title: item.title, source: item.source, url: item.url, projectId: item.projectId,
    context: [item.body, item.why].filter(Boolean).join(" "),
    crumb: `Need you · ${decision ? "Decision" : "To do"}`,
  };
  const ask = () => onAct({ ...base, draft: itemDraft });
  return (
    <div
      className={cn(
        "rounded-lg border p-2.5",
        focus && !done ? "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface-2))]" : "border-[var(--border-subtle)] bg-[var(--surface-2)]",
        done && "opacity-45",
      )}
    >
      <ItemMeta kind={decision ? "Decision" : "To do"} source={item.source} age={item.age} projectId={item.projectId} since={item.since}>
        <IconButton label={done ? "Mark not done" : "Mark done"} size="sm" pressed={done} onClick={onToggle} className="-my-1 shrink-0">
          <Check size={12} />
        </IconButton>
      </ItemMeta>
      <div className={cn("font-medium leading-snug", decision ? "text-base" : "text-sm", done && "line-through")}>{item.title}</div>
      {!done && (
        <>
          {item.body && <p className={cn("text-xs text-[var(--text-secondary)] leading-relaxed mt-1", !open && "line-clamp-2")}>{item.body}</p>}
          {open && item.why && (
            <p className="text-2xs text-[var(--text-tertiary)] leading-relaxed mt-1.5">
              ↳ <b className="font-medium text-[var(--text-secondary)]">{focus ? "Why first:" : "Why:"}</b> {item.why}
            </p>
          )}
          {(item.why || (item.body && item.body.length > 140)) && (
            <button type="button" className="text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline mt-1" onClick={() => setOpen((v) => !v)}>
              {open ? "Show less" : "Show more"}
            </button>
          )}
          {item.facts.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {item.facts.map((f) => {
                const warn = f.startsWith("⚠");
                return (
                  <span
                    key={f}
                    className={cn(
                      "text-2xs rounded-full border px-2 py-px",
                      warn ? "border-[color-mix(in_srgb,var(--warning)_50%,transparent)] text-[var(--text-primary)]" : "border-[var(--border)] text-[var(--text-secondary)]",
                    )}
                  >
                    {f}
                  </span>
                );
              })}
            </div>
          )}
          {decision && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {item.choices.map((c, i) => {
                const draft = draftFor(c.draftId);
                const btn = (
                  <Button
                    key={c.label}
                    size="xs"
                    variant={i === 0 ? "accent" : draft ? "outline" : "ghost"}
                    onClick={() => onAct({ ...base, key: `${item.id}:${c.label}`, answer: c.label, draft })}
                  >
                    {c.label}
                    {draft && (
                      <span className={cn("text-2xs rounded px-1 font-normal", i === 0 ? "bg-[color-mix(in_srgb,var(--background)_22%,transparent)]" : "bg-[var(--surface-3)] text-[var(--text-secondary)]")}>
                        draft
                      </span>
                    )}
                  </Button>
                );
                return draft
                  ? <Tooltip key={c.label} content={<span className="block max-w-[300px] whitespace-pre-wrap">{draft.draft.length > 280 ? `${draft.draft.slice(0, 280)}…` : draft.draft}</span>}>{btn}</Tooltip>
                  : btn;
              })}
            </div>
          )}
          <div className={cn("flex flex-wrap items-center gap-2.5", decision ? "mt-1.5" : "mt-2")}>
            {!decision && item.url && <Button size="xs" variant="outline" onClick={() => openUrl(item.url)}><ExternalLink size={11} /> Open</Button>}
            {!decision && itemDraft && (
              <Button size="xs" variant="accent" onClick={() => onAct({ ...base, draft: itemDraft })}>
                Use the draft
              </Button>
            )}
            {decision && item.url && (
              <button type="button" className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline" onClick={() => openUrl(item.url)}>
                <ExternalLink size={10} /> Open
              </button>
            )}
            {choiceDrafts.length > 0 && (
              <button type="button" className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline" onClick={() => setShowDrafts((v) => !v)}>
                <Pencil size={10} /> {showDrafts ? "Hide drafts" : choiceDrafts.length === 1 ? "Edit draft" : `Edit drafts (${choiceDrafts.length})`}
              </button>
            )}
            <button type="button" className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline" onClick={ask}>
              <MessageSquare size={10} /> Ask Cairn
            </button>
          </div>
          {showDrafts && (
            <div className="mt-2 space-y-2">
              {choiceDrafts.map(({ choice, draft }) => (
                <div key={draft.id}>
                  <div className="text-2xs text-[var(--text-tertiary)] mb-1">
                    For &ldquo;{choice.label}&rdquo;{draft.target ? ` · ${draft.target}` : ""}{edited(draft.id) ? " · edited" : ""}
                  </div>
                  <DraftText
                    text={draft.draft}
                    edited={edited(draft.id)}
                    onSave={(text) => onEdit(draft.id, text === original(draft.id) ? null : text)}
                    onReset={() => onEdit(draft.id, null)}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A draft's text with an Edit mode. Edits are local (per day) and replace
 * Cairn's text in Copy, Send with Cairn and the choice buttons.
 */
function DraftText({ text, edited, onSave, onReset, clamp }: {
  text: string; edited: boolean; onSave: (text: string) => void; onReset: () => void; clamp?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [open, setOpen] = useState(false);
  const long = clamp && (text.length > 260 || text.split("\n").length > 4);
  if (editing) {
    return (
      <div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          rows={Math.min(14, Math.max(4, value.split("\n").length + 1))}
          aria-label="Edit draft"
          className={cn(
            "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--text-primary)] resize-y",
            FOCUS_RING,
          )}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setValue(text); setEditing(false); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { onSave(value); setEditing(false); }
          }}
        />
        <div className="flex gap-1.5 mt-1">
          <Button size="xs" variant="accent" onClick={() => { onSave(value); setEditing(false); }}>Save</Button>
          <Button size="xs" variant="ghost" onClick={() => { setValue(text); setEditing(false); }}>Cancel</Button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div
        className={cn(
          "border-l-2 border-[var(--accent)] bg-[var(--surface)] rounded-r-md px-2.5 py-1.5 text-xs text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap overflow-hidden",
          !open && long && "max-h-[4.7em]",
        )}
      >
        {text}
      </div>
      <div className="flex items-center gap-2.5 mt-1">
        {long && (
          <button type="button" className="text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? "Show less" : "Show all"}
          </button>
        )}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline"
          onClick={() => { setValue(text); setEditing(true); }}
        >
          <Pencil size={10} /> Edit
        </button>
        {edited && (
          <button type="button" className="text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline" onClick={onReset}>
            Use Cairn&apos;s draft
          </button>
        )}
      </div>
    </div>
  );
}

const SEND_HINT = "Opens a panel to edit it and see where it goes. Nothing is sent until you approve the exact call there.";

function DraftCard({ item, done, onDismiss, onAct, slot, edited, onEdit }: {
  item: TodayPrepared; done: boolean; onDismiss: () => void; onAct: (t: TodayActTarget) => void; slot?: string | null;
  edited: boolean; onEdit: (text: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (done) {
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text-tertiary)] flex items-center gap-2">
        <span className="truncate flex-1">{item.title}</span>
        <Button size="xs" variant="ghost" onClick={onDismiss}>Restore</Button>
      </div>
    );
  }
  const kindLabel = { reply: "Reply draft", review: "Review notes", cards: "Card breakdown", note: "Note draft", other: "Draft" }[item.kind];
  const target: TodayActTarget = {
    key: item.id, title: item.title, source: item.source, url: item.url, draft: item, projectId: item.projectId,
    crumb: `Prepared for you · ${kindLabel}`,
  };
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-2.5">
      <ItemMeta kind={edited ? `${kindLabel} · edited` : kindLabel} source={item.target ?? item.source} projectId={item.projectId} since={item.since}>
        <IconButton label="Discard draft" size="sm" onClick={onDismiss} className="-my-1 ml-auto shrink-0"><X size={12} /></IconButton>
      </ItemMeta>
      <div className="text-sm font-medium leading-snug">{item.title}</div>
      <div className="mt-2">
        <DraftText text={item.draft} edited={edited} onSave={(t) => onEdit(t)} onReset={() => onEdit(null)} clamp />
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <Tooltip content={<span className="block max-w-[260px]">{SEND_HINT}</span>}>
          <Button size="xs" variant="accent" onClick={() => onAct(target)}>
            <MessageSquare size={11} /> {item.kind === "cards" ? "Add with Cairn" : "Send with Cairn"}
          </Button>
        </Tooltip>
        <Button
          size="xs"
          variant="outline"
          onClick={() => { void navigator.clipboard.writeText(item.draft); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}
        >
          <Copy size={11} /> {copied ? "Copied" : "Copy"}
        </Button>
        {slot && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onAct({ ...target, key: `${item.id}:plan`, initialPrompt: `Plan this into my free slot today (${slot}): suggest the steps for that time as a short checklist. Don't add anything to my calendar or board.` })}
          >
            Plan in {slot.split("–")[0]} slot
          </Button>
        )}
        {item.url && <Button size="xs" variant="ghost" onClick={() => openUrl(item.url)}><ExternalLink size={11} /> Open</Button>}
      </div>
    </div>
  );
}

function FyiRow({ item }: { item: TodayFyi }) {
  const dot = item.tone === "good" ? "var(--success)" : item.tone === "warn" ? "var(--warning)" : "var(--muted)";
  const body = (
    <>
      <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: dot }} />
      <span className="min-w-0">
        <span className="block text-xs text-[var(--text-primary)]">{item.title}</span>
        <span className="flex gap-1.5 text-2xs text-[var(--text-tertiary)] mt-0.5 min-w-0">
          <ProjectChip projectId={item.projectId} />
          <span className="min-w-0">{[item.detail, item.source].filter(Boolean).join(" · ")}</span>
        </span>
      </span>
    </>
  );
  const cls = "flex gap-2.5 px-1 py-2 border-b border-[var(--border-subtle)] last:border-b-0 text-left w-full";
  return item.url
    ? <button type="button" className={cn(cls, "hover:bg-[var(--surface-2)] rounded-md")} onClick={() => openUrl(item.url)}>{body}</button>
    : <div className={cls}>{body}</div>;
}

function SourceChip({ name, ok, warn, hint }: { name: string; ok?: boolean; warn?: boolean; hint?: string }) {
  const chip = (
    <span
      tabIndex={hint ? 0 : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-2xs bg-[var(--surface)]",
        ok || warn ? "border-[var(--border)] text-[var(--text-secondary)]" : "border-dashed border-[var(--border)] text-[var(--text-tertiary)]",
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: warn ? "var(--warning)" : ok ? "var(--success)" : "var(--muted)" }} />
      {name}
    </span>
  );
  return hint ? <Tooltip content={hint}>{chip}</Tooltip> : chip;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[var(--text-tertiary)] px-1 py-2">{children}</p>;
}
