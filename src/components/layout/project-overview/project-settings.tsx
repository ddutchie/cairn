"use client";

// Project settings gear + modal for the Project Overview header.
// Houses the setup-ish controls that don't belong in the daily-glance column:
// project identity (icon/description/status/priority), the agent code
// directory, and a shortcut to manage tools & connectors (Settings → Tools).

import React, { useState, useEffect, useRef } from "react";
import { Settings2, Check, FolderOpen, Wrench } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon, WORKSPACE_ICONS } from "@/lib/workspace-icons";
import { cn } from "@/lib/utils";
import { PRIORITY_OPTIONS, PROJECT_STATUS_OPTIONS, STATUS_CSS_COLORS, PRIORITY_CSS_COLORS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ModalShell } from "@/components/ui/modal-shell";
import { DialogClose } from "@/components/ui/dialog";
import type { Project, ProjectStatus, Priority } from "@/types";

export function ProjectSettingsButton({ project }: { project: Project }) {
  const { updateProject, setSettingsSection, setView } = useCairnStore(useShallow((s) => ({
    updateProject: s.updateProject,
    setSettingsSection: s.setSettingsSection,
    setView: s.setView,
  })));

  const [open, setOpen] = useState(false);

  const [editIcon, setEditIcon] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editStatus, setEditStatus] = useState<ProjectStatus | "">("");
  const [editPriority, setEditPriority] = useState<Priority | "">("");
  const [codeDirInput, setCodeDirInput] = useState("");

  // Seed the form once per OPEN. `project` identity changes on every store
  // refresh (db:changed rehydrates rows as new objects), so depending on it
  // would overwrite the user's in-progress edits. The ref tracks the freshest
  // project via an effect (never touched during render) and is read only when
  // the modal opens.
  const seedRef = useRef(project);
  useEffect(() => {
    seedRef.current = project;
  }, [project]);
  useEffect(() => {
    if (!open) return;
    const p = seedRef.current;
    setEditIcon(p.icon ?? "");
    setEditDesc(p.description ?? "");
    setEditStatus(p.status);
    setEditPriority(p.priority);
    setCodeDirInput(p.codeDirectory ?? "");
  }, [open]);

  async function handlePickCodeDir() {
    const result = await window.electron?.agent.pickDirectory() as { data: string | null } | undefined;
    if (result?.data) {
      setCodeDirInput(result.data);
    }
  }

  function handleSave() {
    updateProject(project.id, {
      icon: editIcon.trim() || undefined,
      description: editDesc.trim() || undefined,
      status: editStatus || undefined,
      priority: editPriority || undefined,
      codeDirectory: codeDirInput.trim() || null,
    });
    setOpen(false);
  }

  return (
    <>
      <Tooltip content="Project settings" side="bottom">
        <button
          onClick={() => setOpen(true)}
          className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          aria-label="Project settings"
          aria-expanded={open}
        >
          <Settings2 size={14} />
        </button>
      </Tooltip>

      <ModalShell
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        scrollable
        title={
          <span className="flex items-center gap-2">
            <Settings2 size={14} className="text-[var(--text-tertiary)]" />
            Project settings
          </span>
        }
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button variant="accent" size="sm" onClick={handleSave}>
              <Check size={11} className="mr-1" /> Save
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {/* Project identity */}
          <div className="space-y-3">
            <div>
              <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1.5">Icon</label>
              <div className="flex flex-wrap gap-1.5">
                {WORKSPACE_ICONS.map(({ name: iconName }) => (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => setEditIcon(iconName)}
                    className={cn(
                      "w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
                      editIcon === iconName
                        ? "bg-[var(--accent-dim)] ring-1 ring-[var(--accent)] text-[var(--accent)]"
                        : "bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--surface-3,var(--surface-2))]"
                    )}
                  >
                    <ProjectIcon name={iconName} size={13} />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1">Description</label>
              <textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="What is this project about?"
                rows={3}
                className="w-full px-2 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none"
              />
            </div>
            <div>
              <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1">Status</label>
              <div className="grid grid-cols-2 gap-1">
                {PROJECT_STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setEditStatus(s)}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors capitalize",
                      editStatus === s
                        ? "bg-[var(--surface)] ring-1 ring-[var(--accent)] text-[var(--text-primary)]"
                        : "text-[var(--text-tertiary)] hover:bg-[var(--surface)]"
                    )}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STATUS_CSS_COLORS[s] ?? "var(--text-tertiary)" }} />
                    {s.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[0.786rem] text-[var(--text-tertiary)] block mb-1">Priority</label>
              <div className="grid grid-cols-2 gap-1">
                {PRIORITY_OPTIONS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setEditPriority(p)}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs capitalize transition-colors",
                      editPriority === p
                        ? "bg-[var(--surface)] ring-1 ring-[var(--accent)] text-[var(--text-primary)]"
                        : "text-[var(--text-tertiary)] hover:bg-[var(--surface)]"
                    )}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: PRIORITY_CSS_COLORS[p] ?? "var(--text-tertiary)" }} />
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Setup: agent code directory */}
          <div className="space-y-1.5 pt-4 border-t border-[var(--border-subtle)]">
            <label className="text-[0.786rem] text-[var(--text-tertiary)] block">Code directory (agent sessions)</label>
            <div className="flex items-center gap-2">
              <input
                value={codeDirInput}
                onChange={(e) => setCodeDirInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                placeholder="Path for agent sessions…"
                className="flex-1 min-w-0 px-2 py-1.5 text-xs font-mono rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:text-[var(--text-primary)] transition-colors"
              />
              {typeof window !== "undefined" && window.electron && (
                <button
                  onClick={() => void handlePickCodeDir()}
                  className="flex-shrink-0 p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
                  title="Browse"
                  aria-label="Browse code directory"
                >
                  <FolderOpen size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Tools & connectors */}
          <div className="pt-4 border-t border-[var(--border-subtle)]">
            <div className="flex items-center justify-between">
              <span className="text-[0.786rem] text-[var(--text-tertiary)]">Tools & connectors</span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => { setOpen(false); setSettingsSection("tools"); setView("settings"); }}
              >
                <Wrench size={11} /> Manage
              </Button>
            </div>
            <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1.5">
              Install and enable MCP servers and HTTP services, and attach them to this project from the Tools section on this page.
            </p>
          </div>
        </div>
      </ModalShell>
    </>
  );
}
