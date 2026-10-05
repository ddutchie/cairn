"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Sparkles, Plug } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DialogClose } from "@/components/ui/dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { ScheduleBuilder } from "./schedule-builder";
import { BrowseAutomationsContent } from "./browse-automations";
import { TimePicker } from "@/components/ui/time-picker";
import { toolsClient } from "@/lib/ipc/tools";
import type { Automation, ScheduleKind } from "@/store/slices/automations";
import type { RegistryAutomationEntry, RegistryRequirement, McpServerConfig, CustomServiceConfig } from "@/types";

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
  activeHoursStart: string; setActiveHoursStart: (v: string) => void;
  activeHoursEnd: string; setActiveHoursEnd: (v: string) => void;
  scheduleValid: boolean;
  onScheduleValidityChange: (valid: boolean) => void;
  projects: Array<{ id: string; name: string }>;
  /** Workspace the automation runs in — used for connector status checks in browse. */
  activeWorkspaceId: string;
  requires: RegistryRequirement[];
  setRequires: (r: RegistryRequirement[]) => void;
  onSave: () => void;
  /** Called when a community recipe is chosen (pre-fills the form). */
  onPick: (entry: RegistryAutomationEntry) => void;
  /** Key for the ScheduleBuilder so it remounts when a recipe pre-fills it. */
  scheduleKey: string;
}

export function AutomationDialog({
  open, onOpenChange, editing,
  name, setName, instructions, setInstructions,
  kind, setKind, expr, setExpr,
  projectId, setProjectId, timezone, setTimezone,
  maxRuns, setMaxRuns,   approvalMode, setApprovalMode,
  activeHoursStart, setActiveHoursStart, activeHoursEnd, setActiveHoursEnd,
  scheduleValid, onScheduleValidityChange,
  projects,
  activeWorkspaceId, requires, setRequires,
  onSave, onPick, scheduleKey,
}: AutomationDialogProps) {
  const [browse, setBrowse] = useState(false);
  // Installed + enabled connectors (MCP servers / HTTP services) in the active
  // workspace, offered as toggleable "requires" for the automation. Retains the
  // catalog id (communityId) alongside the display name because a recipe
  // requirement may name either; without it a display-name-only match renders an
  // imported catalog requirement as unchecked and lets duplicates slip in.
  type ConnectorOption = { id: string; kind: "mcp" | "service"; name: string; communityId?: string };
  const [connectors, setConnectors] = useState<ConnectorOption[]>([]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void Promise.all([
      toolsClient.listMcpServers(activeWorkspaceId).catch((): McpServerConfig[] => []),
      toolsClient.listServices(activeWorkspaceId).catch((): CustomServiceConfig[] => []),
    ]).then(([mcps, svcs]) => {
      if (cancelled) return;
      setConnectors([
        ...mcps.filter((m) => m.enabled).map((m) => ({ id: m.id, kind: "mcp" as const, name: m.name, communityId: m.communityId })),
        ...svcs.filter((s) => s.enabled).map((s) => ({ id: s.id, kind: "service" as const, name: s.name, communityId: s.communityId })),
      ]);
    });
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);

  // Single matcher for both checked-state and removal so a requirement can never
  // be added twice (or left stuck) when one of its identifiers matches.
  const matchesRequirement = (r: { kind: "mcp" | "service"; name: string }, c: ConnectorOption) =>
    r.kind === c.kind &&
    [c.communityId, c.name].some((value) => value?.toLowerCase() === r.name.toLowerCase());

  const toggleConnector = (c: ConnectorOption) => {
    const has = requires.some((r) => matchesRequirement(r, c));
    setRequires(
      has
        ? requires.filter((r) => !matchesRequirement(r, c))
        : [...requires, { kind: c.kind, name: c.communityId ?? c.name }],
    );
  };

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
            <Button variant="accent" size="sm" onClick={onSave} disabled={!name.trim() || !instructions.trim() || !scheduleValid}>
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
          workspaceId={activeWorkspaceId}
          projectId={projectId}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-tertiary)]">
            The agent runs these instructions on schedule using your AI connection. It works on notes, tasks, tags and boards, and can run scripts you build for it in the Develop modal — script runs are always approved first.
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
          onValidityChange={onScheduleValidityChange}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)]">Only run between</span>
          <div className="w-28"><TimePicker value={activeHoursStart || undefined} onChange={setActiveHoursStart} placeholder="Start" /></div>
          <span className="text-xs text-[var(--text-secondary)]">–</span>
          <div className="w-28"><TimePicker value={activeHoursEnd || undefined} onChange={setActiveHoursEnd} placeholder="End" /></div>
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">(optional)</span>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Project scope</span>
          <Select
            value={projectId}
            onChange={setProjectId}
            size="md"
            className="w-full"
            options={[
              { value: "", label: "Workspace (all projects)" },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)]">Timezone (optional)</span>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/London" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)]">Max runs (optional)</span>
            <Input type="number" min={1} value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} placeholder="Unlimited" />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Approval mode</span>
          <Select
            value={approvalMode}
            onChange={setApprovalMode}
            size="md"
            className="w-full"
            options={[
              { value: "auto", label: "Auto — run freely (writes happen automatically)" },
              { value: "ask", label: "Ask — approve or deny each write" },
            ]}
          />
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">
            {approvalMode === "ask"
              ? "Write actions park in the approval inbox and the run waits for your decision."
              : requires.length > 0
                ? "External connector calls are still gated behind the approval inbox — only data tools run freely."
                : "Data tools run freely; running your scripts (run_script) is always gated behind the approval inbox."}
          </span>
        </label>
        {requires.length > 0 && (
          <div className="rounded-md border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] px-3 py-2 text-[0.714rem] text-[var(--text-secondary)] flex items-center gap-2">
            <Plug size={12} className="text-[var(--accent)] shrink-0" />
            <span>
              This automation needs its attached connectors to run. Runs are offered
              the project&apos;s attached MCP/service tools, and every external call
              waits for your approval.
            </span>
          </div>
        )}

        <div className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Connectors (optional)</span>
          {connectors.length === 0 ? (
            <p className="text-[0.714rem] text-[var(--text-tertiary)]">
              No enabled connectors in this workspace. Add one under Settings → Tools → Browse Community, then it can appear here.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-1">
                {connectors.map((c) => {
                  const selected = requires.some((r) => matchesRequirement(r, c));
                  return (
                    <label
                      key={`${c.kind}:${c.id}`}
                      className={cn(
                        "flex items-center gap-2 rounded border px-2 py-1.5 cursor-pointer transition-colors",
                        selected ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]" : "border-[var(--border)] hover:border-[var(--text-tertiary)]"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleConnector(c)}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-xs text-[var(--text-primary)] truncate">{c.name}</span>
                      <span className="text-[0.65rem] uppercase tracking-wide text-[var(--text-tertiary)] ml-auto border border-[var(--border)] rounded px-1 py-px">
                        {c.kind === "mcp" ? "MCP" : "HTTP"}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-[0.714rem] text-[var(--text-tertiary)]">
                Selected connectors are offered to the run, but only if they&apos;re enabled and attached to the chosen project (Settings → Tools) will their tools actually appear. External calls always wait for your approval.
              </p>
            </>
          )}
        </div>
        </div>
      )}
    </ModalShell>
  );
}
