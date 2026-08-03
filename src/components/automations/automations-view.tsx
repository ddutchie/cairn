"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Play, Pencil, Plus, Trash2, Zap, Clock, RefreshCw } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose,
} from "@/components/ui/dialog";
import { PendingApprovals } from "./pending-approvals";
import type { Automation, ScheduleKind } from "@/store/slices/automations";

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

const KIND_PLACEHOLDER: Record<ScheduleKind, string> = {
  every: "every 24 hours",
  cron: "0 9 * * 1-5",
  once: "once 2026-09-01T09:00:00",
};

export function AutomationsView() {
  const {
    activeWorkspaceId, activeProjectId, projects,
    automations, lastRuns, pendingApprovals,
    fetchAutomations, createAutomation, updateAutomation, deleteAutomation, runNow, fetchRun,
  } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    activeProjectId: s.activeProjectId,
    projects: s.projects,
    automations: s.automations,
    lastRuns: s.lastRuns,
    pendingApprovals: s.pendingApprovals,
    fetchAutomations: s.fetchAutomations,
    createAutomation: s.createAutomation,
    updateAutomation: s.updateAutomation,
    deleteAutomation: s.deleteAutomation,
    runNow: s.runNow,
    fetchRun: s.fetchRun,
  })));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
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

  // Load automations when the workspace changes.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    void fetchAutomations(activeWorkspaceId);
  }, [activeWorkspaceId, fetchAutomations]);

  // Load the latest run for each automation (bounded — automations are few).
  useEffect(() => {
    for (const a of automations) {
      void fetchRun(a.id);
    }
  }, [automations, fetchRun]);

  function openCreate() {
    setEditing(null);
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
    };
    if (editing) {
      await updateAutomation(editing.id, base);
    } else {
      await createAutomation(base);
    }
    setDialogOpen(false);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 md:px-8 pt-4 md:pt-8 pb-4 md:pb-6 border-b border-[var(--border-subtle)]">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Zap size={16} className="text-[var(--accent)]" /> Automations
          </h1>
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
            Scheduled background tasks that run while Cairn is open — data-only, no shell access.
          </p>
        </div>
        <Button variant="accent" size="sm" onClick={openCreate}>
          <Plus size={13} /> New Automation
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 pb-8 space-y-3">
        <PendingApprovals />
        {automations.length === 0 && pendingApprovals.length === 0 && (
          <div className="rounded-lg border border-[var(--border)] p-10 text-center text-sm text-[var(--text-tertiary)]">
            No automations yet. Create one to run scheduled tasks in the background.
          </div>
        )}
        {automations.map((a) => {
          const lastRun = lastRuns[a.id];
          return (
            <div key={a.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-[var(--text-primary)] truncate">{a.name}</h3>
                    {!a.enabled && (
                      <span className="text-[0.714rem] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-tertiary)]">disabled</span>
                    )}
                  </div>
                  {a.description && (
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{a.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[0.714rem] text-[var(--text-tertiary)]">
                    <span className="inline-flex items-center gap-1"><Clock size={11} /> {scheduleLabel(a)}</span>
                    <span>Next: {formatRelative(a.nextRunAt)}</span>
                    <span>{a.runCount} run{a.runCount === 1 ? "" : "s"}</span>
                    {lastRun && (
                      <span className={cn("inline-flex items-center gap-1 capitalize", STATUS_COLOR[lastRun.status])}>
                        Last: {lastRun.status} {lastRun.finishedAt ? `· ${formatRelative(lastRun.finishedAt)}` : ""}
                      </span>
                    )}
                  </div>
                </div>
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
            </div>
          );
        })}
      </div>

      <AutomationDialog
        open={dialogOpen}
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
        onSave={() => void save()}
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
}

function AutomationDialog({
  open, onOpenChange, editing,
  name, setName, instructions, setInstructions,
  kind, setKind, expr, setExpr,
  projectId, setProjectId, timezone, setTimezone,
  maxRuns, setMaxRuns, approvalMode, setApprovalMode, projects, onSave,
}: AutomationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit automation" : "New automation"}</DialogTitle>
        </DialogHeader>
        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-[var(--text-tertiary)]">
            The agent runs these instructions on schedule using your AI connection. It can only touch notes, tasks, tags and boards — no shell.
          </p>
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
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-[var(--text-secondary)]">Schedule</span>
              <select
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as ScheduleKind;
                  setKind(k);
                  setExpr(KIND_PLACEHOLDER[k]);
                }}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              >
                <option value="every">Every N minutes/hours/days</option>
                <option value="cron">Cron (5-field)</option>
                <option value="once">Once</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-[var(--text-secondary)]">Expression</span>
              <Input value={expr} onChange={(e) => setExpr(e.target.value)} placeholder={KIND_PLACEHOLDER[kind]} />
            </label>
          </div>
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
        <div className="px-5 py-4 border-t border-[var(--border-subtle)] flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Cancel</Button>
          </DialogClose>
          <Button variant="accent" size="sm" onClick={onSave} disabled={!name.trim() || !instructions.trim()}>
            <RefreshCw size={13} className="mr-1" /> {editing ? "Save" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
