"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Play, Pencil, Plus, Trash2, Zap, Clock, RefreshCw, Activity, FileText, Kanban, Sparkles } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { revealNote, revealCard } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import {
  DialogClose,
} from "@/components/ui/dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { PendingApprovals } from "./pending-approvals";
import { ScheduleBuilder } from "./schedule-builder";
import { BrowseAutomationsContent } from "./browse-automations";
import type { Automation, AutomationRun, ScheduleKind } from "@/store/slices/automations";
import type { RegistryAutomationEntry } from "@/types";

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const future = diff >= 0;
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ${future ? "away" : "ago"}`;
  if (hrs < 24) return `${hrs}h ${future ? "away" : "ago"}`;
  if (days < 30) return `${days}d ${future ? "away" : "ago"}`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_COLOR: Record<string, string> = {
  done: "text-[var(--ok,#22c55e)]",
  running: "text-[var(--accent)]",
  pending: "text-[var(--text-secondary)]",
  skipped: "text-[var(--text-tertiary)]",
  error: "text-[var(--danger)]",
  denied: "text-[var(--danger)]",
};

function scheduleLabel(a: Automation): string {
  switch (a.scheduleKind) {
    case "every": return `Every ${a.scheduleExpr.replace(/^every\s+/i, "")}`;
    case "cron": return a.scheduleExpr;
    case "once": return `Once at ${new Date(a.scheduleExpr.replace(/^once\s+/i, "")).toLocaleString()}`;
  }
}

/** Read the currently-executing tool from a run's scratch JSON (set by the runner). */
function runScratchTool(run: AutomationRun | undefined): string | null {
  if (!run?.scratch) return null;
  try {
    const scratch = JSON.parse(run.scratch) as { currentTool?: string };
    return typeof scratch.currentTool === "string" && scratch.currentTool ? scratch.currentTool : null;
  } catch {
    return null;
  }
}

export interface ArtifactRef { type: "note" | "task"; id: string; title: string }

/** Notes/cards a run created, from its scratch JSON (set by the runner). */
function runScratchArtifacts(run: AutomationRun | undefined): ArtifactRef[] {
  if (!run?.scratch) return [];
  try {
    const scratch = JSON.parse(run.scratch) as { artifacts?: ArtifactRef[] };
    return Array.isArray(scratch.artifacts) ? scratch.artifacts : [];
  } catch {
    return [];
  }
}

export function AutomationsView() {
  const {
    activeWorkspaceId, activeProjectId, projects, setView,
    automations, lastRuns, pendingApprovals, runsById,
    fetchAutomations, createAutomation, updateAutomation, deleteAutomation, runNow, fetchRun, fetchRuns,
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    activeProjectId: s.activeProjectId,
    projects: s.projects,
    setView: s.setView,
    automations: s.automations,
    lastRuns: s.lastRuns,
    pendingApprovals: s.pendingApprovals,
    runsById: s.runsById,
    fetchAutomations: s.fetchAutomations,
    createAutomation: s.createAutomation,
    updateAutomation: s.updateAutomation,
    deleteAutomation: s.deleteAutomation,
    runNow: s.runNow,
    fetchRun: s.fetchRun,
    fetchRuns: s.fetchRuns,
  })));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [detail, setDetail] = useState<Automation | null>(null);
  /** Community recipe that pre-filled the form (attached as provenance on save). */
  const [communityEntry, setCommunityEntry] = useState<RegistryAutomationEntry | null>(null);
  /** Bumped on each pre-fill so the ScheduleBuilder remounts with the new schedule. */
  const [prefillNonce, setPrefillNonce] = useState(0);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("every");
  const [expr, setExpr] = useState("every 24 hours");
  const [projectId, setProjectId] = useState<string>("");
  const [timezone, setTimezone] = useState("");
  const [maxRuns, setMaxRuns] = useState("");
  const [approvalMode, setApprovalMode] = useState<"auto" | "ask">("auto");

  const wsProjects = useMemo(
    () => (activeWorkspaceId ? projects.filter((p) => p.workspaceId === activeWorkspaceId && !p.archivedAt) : []),
    [projects, activeWorkspaceId]
  );

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

  // Load automations on mount/workspace change, then poll every 5s so run
  // status / next-run / run-count stay live without a reload.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const refresh = () => void fetchAutomations(activeWorkspaceId);
    refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [activeWorkspaceId, fetchAutomations]);

  // Load the latest run for each automation (bounded — automations are few).
  useEffect(() => {
    for (const a of automations) {
      void fetchRun(a.id);
    }
  }, [automations, fetchRun]);

  function openCreate() {
    setEditing(null);
    setCommunityEntry(null);
    setName("");
    setInstructions("");
    setKind("every");
    setExpr("every 24 hours");
    setProjectId(activeProjectId ?? "");
    setTimezone("");
    setMaxRuns("");
    setApprovalMode("auto");
    setDialogOpen(true);
  }

  /** Pre-fill the New Automation form from a community recipe (user can tweak). */
  function prefillFromCommunity(entry: RegistryAutomationEntry) {
    const def = entry.definition;
    setCommunityEntry(entry);
    setName(def.name);
    setInstructions(def.instructions);
    setKind(def.schedule.kind);
    setExpr(def.schedule.expr);
    setTimezone(def.schedule.timezone ?? "");
    setMaxRuns(def.maxRuns !== undefined ? String(def.maxRuns) : "");
    setApprovalMode(def.approvalMode ?? "auto");
    setPrefillNonce((n) => n + 1);
  }

  function openEdit(a: Automation) {
    setEditing(a);
    setName(a.name);
    setInstructions(a.instructions);
    setKind(a.scheduleKind);
    setExpr(a.scheduleExpr);
    setProjectId(a.projectId ?? "");
    setTimezone(a.timezone ?? "");
    setMaxRuns(a.maxRuns === null ? "" : String(a.maxRuns));
    setApprovalMode(a.approvalMode);
    setDialogOpen(true);
  }

  function openDetail(a: Automation) {
    setDetail(a);
    void fetchRuns(a.id);
  }

  async function save() {
    if (!activeWorkspaceId || !name.trim() || !instructions.trim()) return;
    const base = {
      workspaceId: activeWorkspaceId,
      name: name.trim(),
      instructions: instructions.trim(),
      scheduleKind: kind,
      scheduleExpr: expr.trim(),
      projectId: projectId || null,
      timezone: timezone.trim() || null,
      maxRuns: maxRuns.trim() ? Number(maxRuns.trim()) : null,
      approvalMode,
      ...(communityEntry ? { source: "community" as const, communityId: communityEntry.id } : {}),
    };
    if (editing) {
      await updateAutomation(editing.id, base);
    } else {
      await createAutomation(base);
    }
    setCommunityEntry(null);
    setDialogOpen(false);
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-[var(--background)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        <h1 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <Zap size={14} className="text-[var(--accent)]" /> Automations
        </h1>
        <span className="text-xs text-[var(--text-tertiary)] hidden sm:inline">
          — background tasks that run while Cairn is open
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="accent" size="sm" onClick={openCreate}>
            <Plus size={13} /> New Automation
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 space-y-3">
        <PendingApprovals />
        {automations.length === 0 && pendingApprovals.length === 0 && (
          <div className="rounded-lg border border-[var(--border)] p-10 text-center text-sm text-[var(--text-tertiary)]">
            No automations yet. Create one to run scheduled tasks in the background.
          </div>
        )}
        {automations.map((a) => {
          const lastRun = lastRuns[a.id];
          const isRunning = lastRun?.status === "running";
          const currentTool = runScratchTool(lastRun);
          const artifacts = runScratchArtifacts(lastRun);
          return (
            <div key={a.id} className={cn("rounded-lg border bg-[var(--surface)] p-4", isRunning ? "border-[var(--accent)]/40" : "border-[var(--border)]")}>
              <div className="flex items-start justify-between gap-3">
                <button
                  onClick={() => openDetail(a)}
                  className="min-w-0 flex-1 text-left group"
                  title="View automation state"
                >
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-[var(--text-primary)] truncate group-hover:text-[var(--accent)]">
                      {a.name}
                    </h3>
                    {!a.enabled && (
                      <span className="text-[0.714rem] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-tertiary)]">disabled</span>
                    )}
                    {a.projectId && projectName.has(a.projectId) && (
                      <span className="text-[0.714rem] px-1.5 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] max-w-40 truncate">
                        {projectName.get(a.projectId)}
                      </span>
                    )}
                  </div>
                  {a.description && (
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{a.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[0.714rem] text-[var(--text-tertiary)]">
                    <span className="inline-flex items-center gap-1"><Clock size={11} /> {scheduleLabel(a)}</span>
                    <span>Next: {formatRelative(a.nextRunAt)}</span>
                    <span>{a.runCount} run{a.runCount === 1 ? "" : "s"}</span>
                    {isRunning ? (
                      <span className="inline-flex items-center gap-1.5 text-[var(--accent)] animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                        Running{currentTool ? `: ${currentTool}` : "…"}
                      </span>
                    ) : lastRun && (
                      <span className={cn("inline-flex items-center gap-1 capitalize", STATUS_COLOR[lastRun.status])}>
                        Last: {lastRun.status} {lastRun.finishedAt ? `· ${formatRelative(lastRun.finishedAt)}` : ""}
                      </span>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" title="Run now" onClick={() => void runNow(a.id)}>
                    <Play size={13} />
                  </Button>
                  <Button variant="ghost" size="icon" title="Edit" onClick={() => openEdit(a)}>
                    <Pencil size={13} />
                  </Button>
                  <Button variant="ghost" size="icon" title="Delete" onClick={() => void deleteAutomation(a.id)}>
                    <Trash2 size={13} />
                  </Button>
                  <Toggle checked={a.enabled} onCheckedChange={(checked) => void updateAutomation(a.id, { enabled: checked })} />
                </div>
              </div>
              {artifacts.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[0.714rem] text-[var(--text-tertiary)]">Artifacts:</span>
                  {artifacts.map((art) => (
                    <button
                      key={art.id}
                      onClick={() => (art.type === "note" ? revealNote(setView, art.id) : revealCard(setView, art.id))}
                      title={`Open ${art.type === "note" ? "note" : "task"}`}
                      className="inline-flex items-center gap-1 text-[0.714rem] px-2 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors max-w-56"
                    >
                      {art.type === "note" ? <FileText size={10} className="shrink-0" /> : <Kanban size={10} className="shrink-0" />}
                      <span className="truncate">{art.title}</span>
                    </button>
                  ))}
                </div>
              )}
              {isRunning && (
                <div className="mt-3 h-0.5 w-full overflow-hidden rounded-full bg-[var(--accent-dim)]/60">
                  <div className="h-full w-1/3 rounded-full bg-[var(--accent)] animate-cairn-indeterminate" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {dialogOpen && (
        <AutomationDialog
          open
          onOpenChange={setDialogOpen}
          editing={editing}
          name={name} setName={setName}
          instructions={instructions} setInstructions={setInstructions}
          kind={kind} setKind={setKind}
          expr={expr} setExpr={setExpr}
          projectId={projectId} setProjectId={setProjectId}
          timezone={timezone} setTimezone={setTimezone}
          maxRuns={maxRuns} setMaxRuns={setMaxRuns}
          approvalMode={approvalMode} setApprovalMode={setApprovalMode}
          projects={wsProjects}
          onPick={prefillFromCommunity}
          scheduleKey={`${editing?.id ?? "new"}-${prefillNonce}`}
          onSave={() => void save()}
        />
      )}

      <AutomationDetailDialog
        automation={detail}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        runs={detail ? runsById[detail.id] ?? [] : []}
        onEdit={detail ? () => { setDetail(null); openEdit(detail); } : undefined}
        onRunNow={detail ? () => void runNow(detail.id) : undefined}
        projectName={detail && detail.projectId ? projectName.get(detail.projectId) ?? null : null}
      />
    </div>
  );
}

interface AutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Automation | null;
  name: string; setName: (v: string) => void;
  instructions: string; setInstructions: (v: string) => void;
  kind: ScheduleKind; setKind: (v: ScheduleKind) => void;
  expr: string; setExpr: (v: string) => void;
  projectId: string; setProjectId: (v: string) => void;
  timezone: string; setTimezone: (v: string) => void;
  maxRuns: string; setMaxRuns: (v: string) => void;
  approvalMode: "auto" | "ask"; setApprovalMode: (v: "auto" | "ask") => void;
  projects: Array<{ id: string; name: string }>;
  onSave: () => void;
  /** Called when a community recipe is chosen (pre-fills the form). */
  onPick: (entry: RegistryAutomationEntry) => void;
  /** Key for the ScheduleBuilder so it remounts when a recipe pre-fills it. */
  scheduleKey: string;
}

function AutomationDialog({
  open, onOpenChange, editing,
  name, setName, instructions, setInstructions,
  kind, setKind, expr, setExpr,
  projectId, setProjectId, timezone, setTimezone,
  maxRuns, setMaxRuns, approvalMode, setApprovalMode, projects,
  onSave, onPick, scheduleKey,
}: AutomationDialogProps) {
  const [browse, setBrowse] = useState(false);
  return (
    <ModalShell
      open={open}
      onClose={() => onOpenChange(false)}
      size="lg"
      title={editing ? "Edit automation" : browse ? "Browse community" : "New automation"}
      scrollable
      footer={
        !browse && (
          <>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button variant="accent" size="sm" onClick={onSave} disabled={!name.trim() || !instructions.trim()}>
              <RefreshCw size={13} className="mr-1" /> {editing ? "Save" : "Create"}
            </Button>
          </>
        )
      }
    >
      {browse ? (
        <BrowseAutomationsContent
          onPick={(entry) => { onPick(entry); setBrowse(false); }}
          onBack={() => setBrowse(false)}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-tertiary)]">
            The agent runs these instructions on schedule using your AI connection. It can only touch notes, tasks, tags and boards — no shell.
          </p>
          {!editing && (
            <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => setBrowse(true)}>
              <Sparkles size={13} className="text-[var(--accent)]" /> Start from a community recipe
            </Button>
          )}
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly review" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Instructions</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Summarise this week's Done cards and draft a review note…"
            rows={4}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          />
        </label>
        <ScheduleBuilder
          key={scheduleKey}
          initialKind={kind}
          initialExpr={expr}
          timezone={timezone || null}
          onChange={(k, e) => { setKind(k); setExpr(e); }}
        />
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Project scope</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="">Workspace (all projects)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)]">Timezone (optional)</span>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/London" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)]">Max runs (optional)</span>
            <Input value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} placeholder="Unlimited" />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Approval mode</span>
          <select
            value={approvalMode}
            onChange={(e) => setApprovalMode(e.target.value as "auto" | "ask")}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="auto">Auto — run freely (writes happen automatically)</option>
            <option value="ask">Ask — approve or deny each write</option>
          </select>
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">
            {approvalMode === "ask"
              ? "Write actions park in the approval inbox and the run waits for your decision."
              : "Only data tools run — no shell or file edits either way."}
          </span>
        </label>
        </div>
      )}
    </ModalShell>
  );
}

interface AutomationDetailDialogProps {
  automation: Automation | null;
  onOpenChange: (open: boolean) => void;
  runs: AutomationRun[];
  onEdit?: () => void;
  onRunNow?: () => void;
  projectName: string | null;
}

function AutomationDetailDialog({ automation, onOpenChange, runs, onEdit, onRunNow, projectName }: AutomationDetailDialogProps) {
  const [refreshing, setRefreshing] = useState(false);
  const { fetchRuns, setView } = useCairnStore(useShallow((s) => ({ fetchRuns: s.fetchRuns, setView: s.setView })));

  useEffect(() => {
    if (automation) void fetchRuns(automation.id);
  }, [automation, fetchRuns]);

  async function refresh() {
    if (!automation) return;
    setRefreshing(true);
    try { await fetchRuns(automation.id); } finally { setRefreshing(false); }
  }

  // Aggregate notes/cards created across all fetched runs, newest run first, dedup by id.
  const artifacts = useMemo<ArtifactRef[]>(() => {
    const seen = new Set<string>();
    const out: ArtifactRef[] = [];
    for (const r of runs) {
      for (const art of runScratchArtifacts(r)) {
        if (seen.has(art.id)) continue;
        seen.add(art.id);
        out.push(art);
      }
    }
    return out;
  }, [runs]);

  return (
    <ModalShell
      open={automation !== null}
      onClose={() => onOpenChange(false)}
      title={
        automation ? (
          <span className="flex items-center gap-2">
            <Activity size={13} className="text-[var(--accent)]" />
            <span className="truncate">{automation.name}</span>
          </span>
        ) : ""
      }
      scrollable
      footer={
        <>
          {onEdit && (
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil size={12} className="mr-1" /> Edit
            </Button>
          )}
          {onRunNow && (
            <Button variant="accent" size="sm" onClick={onRunNow}>
              <Play size={12} className="mr-1" /> Run now
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Close</Button>
          </DialogClose>
        </>
      }
    >
      {automation && (
        <div className="space-y-4">
          {automation.description && (
            <p className="text-xs text-[var(--text-secondary)]">{automation.description}</p>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <InfoRow label="Schedule" value={scheduleLabel(automation)} />
            <InfoRow label="Project" value={automation.projectId ? projectName ?? "—" : "Workspace (all projects)"} />
            <InfoRow label="Next run" value={formatRelative(automation.nextRunAt)} />
            <InfoRow label="Total runs" value={`${automation.runCount}${automation.maxRuns ? ` / max ${automation.maxRuns}` : ""}`} />
            <InfoRow label="Approval" value={automation.approvalMode === "ask" ? "Ask" : "Auto"} />
            <InfoRow label="Status" value={automation.enabled ? "Enabled" : "Disabled"} />
            {automation.timezone && <InfoRow label="Timezone" value={automation.timezone} />}
          </div>

          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] block mb-2">Artifacts</span>
            {artifacts.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)]">No notes or cards created yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {artifacts.map((art) => (
                  <button
                    key={art.id}
                    onClick={() => (art.type === "note" ? revealNote(setView, art.id) : revealCard(setView, art.id))}
                    title={`Open ${art.type === "note" ? "note" : "task"}`}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors max-w-64"
                  >
                    {art.type === "note" ? <FileText size={11} className="shrink-0" /> : <Kanban size={11} className="shrink-0" />}
                    <span className="truncate">{art.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Run history</span>
              <Button variant="ghost" size="xs" onClick={() => void refresh()} disabled={refreshing}>
                <RefreshCw size={11} className={cn("mr-1", refreshing && "animate-spin")} /> Refresh
              </Button>
            </div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {runs.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)]">No runs yet — it will fire on its schedule or you can run it now.</p>
              )}
              {runs.map((r) => (
                <div key={r.id} className="rounded-md border border-[var(--border)] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={cn("capitalize font-medium", STATUS_COLOR[r.status])}>{r.status}</span>
                    <span className="text-[var(--text-tertiary)] ml-auto">{formatRelative(r.startedAt)}</span>
                  </div>
                  {r.finishedAt && r.status === "done" && (
                    <div className="text-[var(--text-tertiary)] mt-0.5">Finished {formatRelative(r.finishedAt)}</div>
                  )}
                  {r.error && (
                    <div className="text-[var(--danger)] mt-0.5 break-words">{r.error}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.714rem] text-[var(--text-tertiary)]">{label}</div>
      <div className="text-[var(--text-primary)] truncate">{value}</div>
    </div>
  );
}
