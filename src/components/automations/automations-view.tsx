"use client";

import { useEffect, useMemo, useState } from "react";
import { Play, Pencil, Plus, Trash2, Zap, Clock, Activity, FileText, Kanban, Sparkles, Plug } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, id, formatRelative } from "@/lib/utils";
import { revealNote, revealCard } from "@/lib/events";
import { buildAutomationDevPrompt } from "@/lib/automation-dev-prompt";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { AutomationDevModal } from "./automation-dev-modal";
import { RunWatcherModal } from "./run-watcher-modal";
import type { Automation, ScheduleKind } from "@/store/slices/automations";
import type { RegistryAutomationEntry, RegistryRequirement } from "@/types";
import { AutomationBudgetControl } from "./budget-control";
import { RUN_TIME, STATUS_COLOR, scheduleLabel, runScratchTool, runScratchArtifacts } from "./automation-format";
import { AutomationDialog } from "./automation-dialog";
import { AutomationDetailDialog } from "./automation-detail-dialog";
import { automationsClient } from "@/lib/ipc/automations";
import { hasElectron } from "@/lib/ipc/client";

export function AutomationsView() {
  const {
    activeWorkspaceId, activeProjectId, projects, setView,
    automations, lastRuns, runsById,
    fetchAutomations, createAutomation, updateAutomation, deleteAutomation, runNow, fetchRun, fetchRuns,
    addTerminalSession,
    terminalSessions,
    removeTerminalSession,
    automationDevSessions,
    registerAutomationDevSession,
    clearAutomationDevSession,
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    activeProjectId: s.activeProjectId,
    projects: s.projects,
    setView: s.setView,
    automations: s.automations,
    lastRuns: s.lastRuns,
    runsById: s.runsById,
    fetchAutomations: s.fetchAutomations,
    createAutomation: s.createAutomation,
    updateAutomation: s.updateAutomation,
    deleteAutomation: s.deleteAutomation,
    runNow: s.runNow,
    fetchRun: s.fetchRun,
    fetchRuns: s.fetchRuns,
    addTerminalSession: s.addTerminalSession,
    terminalSessions: s.terminalSessions,
    removeTerminalSession: s.removeTerminalSession,
    automationDevSessions: s.automationDevSessions,
    registerAutomationDevSession: s.registerAutomationDevSession,
    clearAutomationDevSession: s.clearAutomationDevSession,
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
  const [activeHoursStart, setActiveHoursStart] = useState("");
  const [activeHoursEnd, setActiveHoursEnd] = useState("");
  const [scheduleValid, setScheduleValid] = useState(true);
  /** External connectors the automation needs in scope (from a community recipe). */
  const [requires, setRequires] = useState<RegistryRequirement[]>([]);

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
    setActiveHoursStart("");
    setActiveHoursEnd("");
    setRequires([]);
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
    // Connector-aware recipes default to 'ask' — external tool calls stay gated
    // behind the approval inbox (never auto-approved side effects), regardless
    // of the recipe's own approvalMode hint.
    setApprovalMode(def.approvalMode ?? (def.requires?.length ? "ask" : "auto"));
    setActiveHoursStart("");
    setActiveHoursEnd("");
    setRequires(def.requires ?? []);
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
    setActiveHoursStart(a.activeHoursStart ?? "");
    setActiveHoursEnd(a.activeHoursEnd ?? "");
    setRequires(a.requires ?? []);
    setDialogOpen(true);
  }

  function openDetail(a: Automation) {
    setDetail(a);
    void fetchRuns(a.id);
  }

  async function save() {
    if (!activeWorkspaceId || !name.trim() || !instructions.trim() || !scheduleValid) return;
    // Parse maxRuns strictly: empty → null, else a positive integer (never NaN).
    const maxRunsParsed = maxRuns.trim() ? parseInt(maxRuns.trim(), 10) : null;
    const base = {
      workspaceId: activeWorkspaceId,
      name: name.trim(),
      instructions: instructions.trim(),
      scheduleKind: kind,
      scheduleExpr: expr.trim(),
      projectId: projectId || null,
      timezone: timezone.trim() || null,
      maxRuns: maxRunsParsed !== null && Number.isInteger(maxRunsParsed) && maxRunsParsed > 0 ? maxRunsParsed : null,
      approvalMode,
      activeHoursStart: activeHoursStart.trim() || null,
      activeHoursEnd: activeHoursEnd.trim() || null,
      requires,
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

  const [developing, setDeveloping] = useState(false);
  const [developError, setDevelopError] = useState<string | null>(null);
  const [devAutomation, setDevAutomation] = useState<Automation | null>(null);
  const [devSessionId, setDevSessionId] = useState<string | null>(null);
  const [watchedAutomation, setWatchedAutomation] = useState<Automation | null>(null);
  const [watchedRunId, setWatchedRunId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  /**
   * Open (or REOPEN) the self-contained dev modal for an automation. If a dev
   * session is still running for it, reopening reuses it so in-flight work is
   * never lost; `forceNew` aborts the old session and starts a fresh one. The
   * restricted "automation-dev" persona has file tools only — it can't touch
   * the board.
   */
  async function develop(a: Automation, forceNew = false) {
    const electron = window.electron;
    if (!electron) return;
    setDeveloping(true);
    setDevelopError(null);
    try {
      const folder = await automationsClient.folder(a.id);
      if (!forceNew) {
        const existing = automationDevSessions[a.id];
        if (existing && terminalSessions.some((t) => t.sessionId === existing)) {
          setDevAutomation(a);
          setDevSessionId(existing);
          return;
        }
      }
      const projectId = a.projectId ?? activeProjectId;
      if (!projectId) {
        setDevelopError("This automation is workspace-scoped with no active project. Pick a project first.");
        return;
      }
      if (forceNew) {
        const stale = automationDevSessions[a.id];
        if (stale && terminalSessions.some((t) => t.sessionId === stale)) {
          electron.session.destroy(stale);
          removeTerminalSession(stale);
        }
        clearAutomationDevSession(a.id);
      }
      const sessionId = id();
      const now = new Date().toISOString();
      const taskTitle = `Develop: ${a.name}`;
      await electron.session.createSession({
        id: sessionId,
        projectId,
        taskTitle,
        taskId: a.id,
        cwd: folder,
        mode: "execute",
        role: "automation-dev",
        spawnedAt: now,
      });
      addTerminalSession({
        sessionId,
        taskId: a.id,
        taskTitle,
        agentId: "cairn-agent",
        agentName: "Cairn Agent",
        projectId,
        cwd: folder,
        status: "running",
        exitCode: null,
        spawnedAt: now,
        sessionType: "coding",
        messages: [],
        mode: "execute",
        role: "automation-dev",
        initialPrompt: buildAutomationDevPrompt(a),
      });
      registerAutomationDevSession(a.id, sessionId);
      setDevAutomation(a);
      setDevSessionId(sessionId);
    } catch (err) {
      setDevelopError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeveloping(false);
    }
  }

  /** Apply the agent-authored manifest.json (instructions / env schema) to the row. */
  async function syncFromManifest(a: Automation) {
    if (!hasElectron("automation")) return;
    setSyncing(true);
    setSyncStatus(null);
    try {
      const { dropped } = await automationsClient.syncFromManifest(a.id);
      if (activeWorkspaceId) await fetchAutomations(activeWorkspaceId);
      setSyncStatus(
        dropped.length > 0
          ? `Synced the recipe — skipped ${dropped.length} unsafe standing rule${dropped.length === 1 ? "" : "s"}: ${dropped.join("; ")}`
          : "Synced the automation's recipe from the manifest.",
      );
    } catch (err) {
      setSyncStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
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
          <AutomationBudgetControl />
          <Button variant="accent" size="sm" onClick={openCreate}>
            <Plus size={13} /> New Automation
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 space-y-3">
        {developError && (
          <div className="rounded-md border border-[var(--danger)]/40 bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-xs text-[var(--danger)] flex items-center gap-2">
            <span className="flex-1">{developError}</span>
            <button type="button" onClick={() => setDevelopError(null)} className="hover:text-[var(--text-primary)]">Dismiss</button>
          </div>
        )}
        {automations.length === 0 && (
          <EmptyState
            icon={Zap}
            title="No automations yet."
            description="Create one to run scheduled tasks in the background."
          />
        )}
        {automations.map((a) => {
          const lastRun = lastRuns[a.id];
          const isRunning = lastRun?.status === "running";
          const currentTool = runScratchTool(lastRun);
          const artifacts = runScratchArtifacts(lastRun);
          return (
            <div key={a.id} className={cn("rounded-lg border bg-[var(--surface)] p-4", isRunning ? "border-[var(--accent)]/40" : "border-[var(--border)]")}>
              <div className="flex items-start justify-between gap-3">
                <Tooltip content="View automation state">
                  <button
                    onClick={() => openDetail(a)}
                    className="min-w-0 flex-1 text-left group"
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
                    {a.requires.length > 0 && (
                      <Tooltip content={`Needs: ${a.requires.map((r) => r.name).join(", ")}`}>
                        <span className="inline-flex items-center gap-1 text-[0.714rem] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-secondary)] cursor-default">
                          <Plug size={9} />
                          {a.requires.map((r) => r.name).join(", ")}
                        </span>
                      </Tooltip>
                    )}
                  </div>
                  {a.description && (
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{a.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[0.714rem] text-[var(--text-tertiary)]">
                    <span className="inline-flex items-center gap-1"><Clock size={11} /> {scheduleLabel(a)}</span>
                    <span>Next: {formatRelative(a.nextRunAt, RUN_TIME)}</span>
                    <span>{a.runCount} run{a.runCount === 1 ? "" : "s"}</span>
                    {isRunning ? (
                      <span className="inline-flex items-center gap-1.5 text-[var(--accent)] animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                        Running{currentTool ? `: ${currentTool}` : "…"}
                      </span>
                    ) : lastRun && (
                      <span className={cn("inline-flex items-center gap-1 capitalize", STATUS_COLOR[lastRun.status])}>
                        Last: {lastRun.status} {lastRun.finishedAt ? `· ${formatRelative(lastRun.finishedAt, RUN_TIME)}` : ""}
                      </span>
                    )}
                  </div>
                  </button>
                  </Tooltip>
                <div className="flex items-center gap-1 shrink-0">
                  {isRunning && lastRun && (
                    <Tooltip content="Watch this run live">
                      <Button variant="ghost" size="icon" onClick={() => { setWatchedAutomation(a); setWatchedRunId(lastRun.id); }}>
                        <Activity size={13} />
                      </Button>
                    </Tooltip>
                  )}
                  <Tooltip content="Develop scripts (opens the agent in the automation folder)">
                    <Button variant="ghost" size="icon" disabled={developing} onClick={() => void develop(a)}>
                      <Sparkles size={13} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Run now">
                    <Button variant="ghost" size="icon" onClick={() => void runNow(a.id)}>
                      <Play size={13} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Edit">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(a)}>
                      <Pencil size={13} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Delete">
                    <Button variant="ghost" size="icon" onClick={() => void deleteAutomation(a.id)}>
                      <Trash2 size={13} />
                    </Button>
                  </Tooltip>
                  <Toggle checked={a.enabled} onCheckedChange={(checked) => void updateAutomation(a.id, { enabled: checked })} />
                </div>
              </div>
              {artifacts.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[0.714rem] text-[var(--text-tertiary)]">Artifacts:</span>
                  {artifacts.map((art) => (
                    <Tooltip key={art.id} content={`Open ${art.type === "note" ? "note" : "task"}`}>
                      <button
                        onClick={() => (art.type === "note" ? revealNote(setView, art.id) : revealCard(setView, art.id))}
                        className="inline-flex items-center gap-1 text-[0.714rem] px-2 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors max-w-56"
                      >
                        {art.type === "note" ? <FileText size={10} className="shrink-0" /> : <Kanban size={10} className="shrink-0" />}
                        <span className="truncate">{art.title}</span>
                      </button>
                    </Tooltip>
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
          activeHoursStart={activeHoursStart} setActiveHoursStart={setActiveHoursStart}
          activeHoursEnd={activeHoursEnd} setActiveHoursEnd={setActiveHoursEnd}
          scheduleValid={scheduleValid}
          onScheduleValidityChange={setScheduleValid}
          projects={wsProjects}
          activeWorkspaceId={activeWorkspaceId ?? ""}
          requires={requires}
          setRequires={setRequires}
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
        onDevelop={detail ? () => void develop(detail) : undefined}
        developing={developing}
        onSyncFromManifest={detail ? () => void syncFromManifest(detail) : undefined}
        syncing={syncing}
        syncStatus={syncStatus}
        onEnvChanged={activeWorkspaceId ? () => void fetchAutomations(activeWorkspaceId) : undefined}
        projectName={detail && detail.projectId ? projectName.get(detail.projectId) ?? null : null}
      />

      <AutomationDevModal
        automation={devAutomation}
        sessionId={devSessionId}
        onClose={() => { setDevAutomation(null); setDevSessionId(null); }}
        onSyncFromManifest={devAutomation ? () => void syncFromManifest(devAutomation) : undefined}
        syncing={syncing}
        onRunNow={devAutomation ? () => void runNow(devAutomation.id) : undefined}
        onStartOver={devAutomation ? () => void develop(devAutomation, true) : undefined}
      />

      <RunWatcherModal
        automation={watchedAutomation}
        runId={watchedRunId}
        onClose={() => { setWatchedAutomation(null); setWatchedRunId(null); }}
      />
    </div>
  );
}

