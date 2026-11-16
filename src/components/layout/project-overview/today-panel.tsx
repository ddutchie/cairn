"use client";

/**
 * Overview → Today. Renders the brief the built-in Today automation writes
 * (`electron/lib/today.ts`): a headline naming the first decision, four
 * stat tiles, the cairn stack, the day strip (free time first), and the three
 * lanes (Need you as decisions, Prepared for you, Moving without you). A draft
 * that answers a decision sits on that decision's choice, not in Prepared. When Today is off
 * the tab shows its setup instead.
 *
 * Every action here is local or goes through chat: drafts are copied, or handed
 * to a chat session that asks before it posts anything.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, MessageSquare, Pencil, Play, RefreshCw, Settings2, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { todayClient, automationsClient } from "@/lib/ipc/automations";
import { appClient } from "@/lib/ipc/app";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Toggle } from "@/components/ui/toggle";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { useContainerDims, useFontScale, useNow } from "@/lib/viz/hooks";
import { TodayActPanel, type TodayActTarget } from "./today-act-panel";
import { CairnStack, MiniStack, TODAY_SEEN_EVENT, markTodaySeen, todaySeenAt, type StackLane } from "./today-stack";
import {
  dayBlocks, formatClock, formatMinutes, linkedDraftIds, localDate,
  type TodayDay, type TodayFyi, type TodayNeedItem, type TodayPrepared, type TodayState,
} from "../../../../shared/today/brief";

type Lane = StackLane;

const DISMISS_KEY = (projectId: string, date: string) => `today:dismissed:${projectId}:${date}`;
const EDITS_KEY = (projectId: string, date: string) => `today:edits:${projectId}:${date}`;

function readJson<T>(key: string, fallback: T): T {
  try { return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback; } catch { return fallback; }
}

/** What this browser keeps for a brief: added to the debug export. */
function readLocalState(projectId: string, date: string) {
  return {
    dismissed: readJson<string[]>(DISMISS_KEY(projectId, date), []),
    edits: readJson<Record<string, string>>(EDITS_KEY(projectId, date), {}),
  };
}

/** Drafts the user rewrote, by draft id. Kept per day, like done and discard. */
function useDraftEdits(projectId: string, date: string | undefined) {
  const key = date ? EDITS_KEY(projectId, date) : null;
  const [version, setVersion] = useState(0);
  const edits = useMemo(() => {
    void version;
    return key ? readJson<Record<string, string>>(key, {}) : {};
  }, [key, version]);
  const setEdit = useCallback((id: string, text: string | null) => {
    if (!key) return;
    const next = { ...edits };
    if (text === null) delete next[id]; else next[id] = text;
    localStorage.setItem(key, JSON.stringify(next));
    setVersion((v) => v + 1);
  }, [key, edits]);
  return { edits, setEdit };
}

function useDismissed(projectId: string, date: string | undefined) {
  const key = date ? DISMISS_KEY(projectId, date) : null;
  const [version, setVersion] = useState(0);
  const ids = useMemo(() => {
    void version;
    if (!key) return new Set<string>();
    try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]); } catch { return new Set<string>(); }
  }, [key, version]);
  const toggle = useCallback((id: string) => {
    if (!key) return;
    const next = new Set(ids);
    if (next.has(id)) next.delete(id); else next.add(id);
    localStorage.setItem(key, JSON.stringify([...next]));
    setVersion((v) => v + 1);
  }, [key, ids]);
  const set = useCallback((id: string, on: boolean) => {
    if (!key || ids.has(id) === on) return;
    const next = new Set(ids);
    if (on) next.add(id); else next.delete(id);
    localStorage.setItem(key, JSON.stringify([...next]));
    setVersion((v) => v + 1);
  }, [key, ids]);
  return { ids, toggle, set };
}

function openUrl(url?: string) {
  if (url && /^https?:\/\//i.test(url)) void appClient.openExternal(url);
}

export function TodayPanel({ workspaceId, projectId, projectName }: { workspaceId: string; projectId: string; projectName: string }) {
  const [state, setState] = useState<TodayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveTool, setLiveTool] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await todayClient.get(workspaceId, projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live progress: which tool the run is on, and a refetch when it ends.
  useEffect(() => {
    if (!state?.automationId) return;
    const id = state.automationId;
    return automationsClient.onRunEvent((ev) => {
      if (ev.automationId !== id) return;
      if (ev.event === "started") { setLiveTool("Starting"); setState((s) => (s ? { ...s, running: true } : s)); }
      if (ev.event === "tool" && ev.status === "start") setLiveTool(ev.label ?? ev.tool ?? null);
      if (ev.event === "finished") {
        setLiveTool(null);
        // The brief is saved just after `finished` is sent.
        window.setTimeout(() => void refresh(), 600);
      }
    });
  }, [state?.automationId, refresh]);

  // Fallback while a run is in flight (e.g. a scheduled run started before this tab opened).
  useEffect(() => {
    if (!state?.running) return;
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [state?.running, refresh]);

  const run = async () => {
    setState((s) => (s ? { ...s, running: true } : s));
    setLiveTool("Starting");
    try { await todayClient.run(workspaceId, projectId); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    void refresh();
  };

  if (!state) {
    return <div className="flex justify-center py-16">{error ? <p className="text-sm text-[var(--danger)]">{error}</p> : <MiniStack size={28} busy label="Loading Today" />}</div>;
  }

  if (!state.enabled) {
    return (
      <TodaySetup
        state={state}
        projectName={projectName}
        onEnable={async (time, weekdaysOnly, runNow) => {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          setState(await todayClient.enable({ workspaceId, projectId, time, weekdaysOnly, timezone: tz }));
          if (runNow) await run();
        }}
      />
    );
  }

  return (
    <TodayView
      state={state}
      workspaceId={workspaceId}
      projectId={projectId}
      liveTool={liveTool}
      error={error}
      onRun={run}
      onSchedule={async (time, weekdaysOnly) => {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setState(await todayClient.enable({ workspaceId, projectId, time, weekdaysOnly, timezone: tz }));
      }}
      onDisable={async () => setState(await todayClient.disable(workspaceId, projectId))}
      onExport={async () => {
        const date = state.brief?.date;
        return todayClient.export({ workspaceId, projectId, local: date ? readLocalState(projectId, date) : undefined });
      }}
    />
  );
}

/**
 * What the Overview tab strip shows for Today: whether it's on, whether a run
 * is gathering, and whether the latest brief hasn't been opened yet.
 */
export function useTodayBadge(workspaceId: string | null, projectId: string | null) {
  const [badge, setBadge] = useState<{ enabled: boolean; running: boolean; unseen: boolean; automationId: string | null }>(
    { enabled: false, running: false, unseen: false, automationId: null },
  );
  const load = useCallback(async () => {
    if (!workspaceId || !projectId) return;
    try {
      const st = await todayClient.get(workspaceId, projectId);
      const gen = st.brief?.generatedAt;
      setBadge({ enabled: st.enabled, running: st.running, unseen: !!gen && todaySeenAt(projectId) !== gen, automationId: st.automationId });
    } catch { /* off-Electron or no project: no badge */ }
  }, [workspaceId, projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onSeen = () => void load();
    window.addEventListener(TODAY_SEEN_EVENT, onSeen);
    const off = automationsClient.onRunEvent((ev) => {
      if (!badge.automationId || ev.automationId !== badge.automationId) return;
      if (ev.event === "started") setBadge((b) => ({ ...b, running: true }));
      if (ev.event === "finished") window.setTimeout(() => void load(), 600);
    });
    return () => { window.removeEventListener(TODAY_SEEN_EVENT, onSeen); off(); };
  }, [load, badge.automationId]);
  return badge;
}

// ── Setup (Today is off) ────────────────────────────────────────────────────

function TodaySetup({ state, projectName, onEnable }: {
  state: TodayState;
  projectName: string;
  onEnable: (time: string, weekdaysOnly: boolean, runNow: boolean) => Promise<void>;
}) {
  const mcpServers = useCairnStore((s) => s.mcpServers);
  const [time, setTime] = useState(state.time);
  const [weekdaysOnly, setWeekdaysOnly] = useState(state.weekdaysOnly);
  const [busy, setBusy] = useState(false);
  const connectors = mcpServers.filter((s) => s.enabled);

  return (
    <div className="max-w-[640px] mx-auto py-10">
      <CairnStack counts={{ need: 3, prep: 2, fyi: 4 }} className="mb-6" />
      <h2 className="text-lg font-semibold">Start each day with Today</h2>
      <p className="text-sm text-[var(--text-secondary)] mt-2 leading-relaxed">
        Each morning Cairn reads {projectName}&apos;s board and your connected apps, then sorts what it finds into what needs you,
        what it has already drafted for you, and what is moving without you. It only reads: nothing is sent, posted or changed
        until you act on it.
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
            Uses the connectors attached to this project (or to all projects). Gathered content is sent to your configured model.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-5">
        <Button variant="accent" disabled={busy} onClick={async () => { setBusy(true); try { await onEnable(time, weekdaysOnly, true); } finally { setBusy(false); } }}>
          <Play size={12} /> Turn on and run now
        </Button>
        <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { await onEnable(time, weekdaysOnly, false); } finally { setBusy(false); } }}>
          Turn on
        </Button>
      </div>
      <p className="text-2xs text-[var(--text-tertiary)] mt-3">It also appears in Automations as &ldquo;Today&rdquo;, with its run history.</p>
    </div>
  );
}

// ── The brief ───────────────────────────────────────────────────────────────

function TodayView({ state, workspaceId, projectId, liveTool, error, onRun, onSchedule, onDisable, onExport }: {
  state: TodayState;
  workspaceId: string;
  projectId: string;
  liveTool: string | null;
  error: string | null;
  onRun: () => void;
  onSchedule: (time: string, weekdaysOnly: boolean) => Promise<void>;
  onDisable: () => Promise<void>;
  onExport: () => Promise<{ filePath: string } | null>;
}) {
  const brief = state.brief;
  const { ids: dismissed, toggle, set: setDismissed } = useDismissed(projectId, brief?.date);
  // The item open in the act panel; `doneId` is what "done" marks in Today.
  const [act, setAct] = useState<(TodayActTarget & { doneId: string }) | null>(null);
  const { edits, setEdit } = useDraftEdits(projectId, brief?.date);
  // A brief the user hasn't opened yet stacks itself in once, then counts as seen.
  // Captured once per mount: a brief that lands while the tab is open differs from it too.
  const [seenAtMount] = useState(() => todaySeenAt(projectId));
  const unseen = !!brief && seenAtMount !== brief.generatedAt;
  useEffect(() => { if (brief) markTodaySeen(projectId, brief.generatedAt); }, [projectId, brief]);
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
      <Button variant="accent" size="sm" onClick={onRun} disabled={state.running}>
        {state.running ? <MiniStack size={13} busy /> : <RefreshCw size={12} />} {state.running ? "Gathering" : brief ? "Refresh" : "Run now"}
      </Button>
      <TodaySettings key={`${state.time}-${state.weekdaysOnly}`} state={state} onSchedule={onSchedule} onDisable={onDisable} onExport={onExport} />
      <span className="text-2xs text-[var(--text-tertiary)] ml-1">
        {state.running && liveTool ? `Reading: ${liveTool}` : (
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
          {state.running ? "Cairn is reading your board and connected apps. This usually takes a minute or two." : "Today is on. Run it now or wait for the next scheduled run."}
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
    <div className="pb-6">
      <div className="grid gap-8 items-end pb-5 border-b border-[var(--border-subtle)] grid-cols-1 @3xl:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          <div className="text-xs text-[var(--text-tertiary)] font-mono">
            {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }).toUpperCase()}
            {isToday && ` · ${formatClock(nowMin)}`}
            {!isToday && <span className="text-[var(--warning)] font-sans"> · from an earlier day</span>}
          </div>
          <h2 className="text-2xl leading-tight mt-2 mb-1.5 max-w-[24ch] font-normal tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {brief.headline}
          </h2>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-[58ch]">{brief.lede}</p>
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
          {header}
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
              onAct={(t) => setAct({ ...t, doneId: n.id })}
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
              onAct={(t) => setAct({ ...t, doneId: p.id })}
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
          {brief.fyi.map((f, i) => <FyiRow key={i} item={f} />)}
        </LaneBox>
      </div>

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
          projectId={projectId}
          date={brief.date}
          target={act}
          onSaveDraft={(id, text) => setEdit(id, text === null || text === original(id) ? null : text)}
          onDone={() => setDismissed(act.doneId, true)}
          onUndoDone={() => setDismissed(act.doneId, false)}
          onClose={() => setAct(null)}
        />
      )}
    </div>
  );
}

function TodaySettings({ state, onSchedule, onDisable, onExport }: {
  state: TodayState;
  onSchedule: (time: string, weekdaysOnly: boolean) => Promise<void>;
  onDisable: () => Promise<void>;
  onExport: () => Promise<{ filePath: string } | null>;
}) {
  const [time, setTime] = useState(state.time);
  const [weekdaysOnly, setWeekdaysOnly] = useState(state.weekdaysOnly);
  const [exported, setExported] = useState<string | null>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm"><Settings2 size={12} /> Schedule</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3 space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[var(--text-secondary)] w-20">Refresh at</span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value || "07:00")}
            className="h-7 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 text-xs text-[var(--text-primary)]"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <Toggle checked={weekdaysOnly} onCheckedChange={setWeekdaysOnly} label="Weekdays only" /> Weekdays only
        </label>
        <div className="flex justify-between pt-1">
          <Button size="xs" variant="ghost" className="text-[var(--danger)]" onClick={() => void onDisable()}>Turn off Today</Button>
          <Button size="xs" variant="accent" onClick={() => void onSchedule(time, weekdaysOnly)}>Save</Button>
        </div>
        <div className="border-t border-[var(--border-subtle)] pt-2.5">
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              try {
                const r = await onExport();
                if (r) setExported(r.filePath);
              } catch (e) { setExported(`Export failed: ${e instanceof Error ? e.message : String(e)}`); }
            }}
          >
            <Download size={11} /> Export data
          </Button>
          <p className="text-2xs text-[var(--text-tertiary)] mt-1.5 leading-relaxed break-all">
            {exported ?? "Saves the recipe, the brief, recent runs and the last run's log and session events as one JSON file, for debugging. It holds the content Cairn read."}
          </p>
        </div>
      </PopoverContent>
    </Popover>
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
          {visible.map((b) => {
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
                key={`${b.kind}-${b.start}`}
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
              <div key={`${b.kind}-${b.start}`} className="contents">
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

function ItemMeta({ kind, source, age, children }: { kind: string; source: string; age?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)] mb-1 min-w-0">
      <span className="font-medium text-[var(--text-secondary)] shrink-0">{kind}</span>
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
    key: item.id, title: item.title, source: item.source, url: item.url,
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
      <ItemMeta kind={decision ? "Decision" : "To do"} source={item.source} age={item.age}>
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
    key: item.id, title: item.title, source: item.source, url: item.url, draft: item,
    crumb: `Prepared for you · ${kindLabel}`,
  };
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-2.5">
      <ItemMeta kind={edited ? `${kindLabel} · edited` : kindLabel} source={item.target ?? item.source}>
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
        <span className="block text-2xs text-[var(--text-tertiary)] mt-0.5">{[item.detail, item.source].filter(Boolean).join(" · ")}</span>
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
