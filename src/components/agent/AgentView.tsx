"use client";

/**
 * AgentView — full-screen three-pane coding agent workspace (⌘7).
 *
 * Pane resizing is done via direct DOM style mutation (no React state during
 * drag) so the terminal reflows in the same event tick as the mouse move.
 * TerminalManager.fitAll() is called synchronously on every mousemove so
 * xterm cols/rows update with zero lag.
 */

import { useRef, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { FileTree } from "./FileTree";
import { AgentEditor } from "./AgentEditor";
import { AgentBottomTerminal } from "./AgentBottomTerminal";
import { DiffViewer } from "./DiffViewer";
import { GitView } from "./GitView";
import { ArchitectureView } from "./ArchitectureView";
import { ArchitectureSidebar } from "./ArchitectureSidebar";
import { TerminalManager } from "./TerminalManager";
import { Bot, FolderOpen, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import { useResizableDivider } from "@/hooks/useResizableDivider";
import { IconButton } from "@/components/ui/icon-button";

const MIN_TREE_WIDTH = 160;
const DEFAULT_TREE_WIDTH = 220;

const MIN_BOTTOM_HEIGHT = 80;
const MAX_BOTTOM_HEIGHT = 600;
const DEFAULT_BOTTOM_HEIGHT = 220;

type CentreTab = "editor" | "diff" | "git" | "architecture";

export function AgentView() {
  const { activeProjectId, projects, updateProject } = useCairnStore(useShallow((s) => ({ activeProjectId: s.activeProjectId, projects: s.projects, updateProject: s.updateProject })));
  // The structure panel only has something to show once a file is open; until
  // then the editor's own empty state says what to do.
  const hasOpenFile = useCairnStore((s) => s.openEditorFiles.length > 0);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const codeDirectory = project?.codeDirectory ?? null;

  async function handlePickCodeDir() {
    if (!project) return;
    const picked = await window.electron?.agent.pickDirectory();
    if (picked) updateProject(project.id, { codeDirectory: picked });
  }

  const [centreTab, setCentreTab] = useState<CentreTab>("editor");
  // Bottom terminal height lives in React state so AgentBottomTerminal re-renders with the new height
  const [bottomHeight, setBottomHeight] = useState(DEFAULT_BOTTOM_HEIGHT);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);

  // DOM refs for the resizable tree pane — mutated directly,
  // never stored in React state, so no re-render occurs during drag.
  const treePaneRef      = useRef<HTMLDivElement>(null);
  const leftDividerRef   = useRef<HTMLDivElement>(null);
  const bottomDividerRef = useRef<HTMLDivElement>(null);

  // Set initial widths once on mount via DOM (avoids a React render cycle)
  useEffect(() => {
    if (treePaneRef.current) treePaneRef.current.style.width = `${DEFAULT_TREE_WIDTH}px`;
    // Re-run when codeDirectory appears: the tree pane only mounts once a codebase
    // is connected, so an empty dep array would leave its width unset (the ref is
    // null at first mount when there's no codebase).
  }, [codeDirectory]);

  // ── Drag logic ─────────────────────────────────────────────────────────────
  // Re-attach when the codebase becomes available: the divider elements only
  // exist once `codeDirectory` is set (the no-codebase branch returns early).
  useResizableDivider(leftDividerRef, {
    axis: "x",
    startSize: () => treePaneRef.current?.offsetWidth ?? DEFAULT_TREE_WIDTH,
    onMove: (delta, start) => {
      if (treePaneRef.current) treePaneRef.current.style.width = `${Math.max(MIN_TREE_WIDTH, start + delta)}px`;
    },
    onEnd: () => TerminalManager.fitAll(),
  }, [codeDirectory]);
  useResizableDivider(bottomDividerRef, {
    axis: "y",
    // Read from the DOM so a drag starts from the rendered height, not stale state.
    startSize: () =>
      (bottomDividerRef.current?.nextElementSibling as HTMLElement | null)?.offsetHeight ?? DEFAULT_BOTTOM_HEIGHT,
    // Dragging up (negative delta) makes the bottom pane taller.
    onMove: (delta, start) => setBottomHeight(Math.min(MAX_BOTTOM_HEIGHT, Math.max(MIN_BOTTOM_HEIGHT, start - delta))),
    onEnd: () => TerminalManager.fitAll(),
  }, [codeDirectory]);

  // No codebase on this project — show only chat, not the coding-agent workspace.
  // Chat is provided by the RightPanel drawer (auto-opened on agent view in page.tsx),
  // so we must NOT
  // render a SessionPane here — doing so double-mounts ChatPanel/useChatStream and
  // causes duplicate assistant messages (both onDone subscriptions call addMessage).
  if (!codeDirectory) {
    return (
      <div className="flex flex-1 min-h-0 overflow-hidden bg-[var(--background)]">
        <EmptyState
          icon={Bot}
          iconTone="accent"
          title="No codebase connected"
          description="This project has no code directory. Set one to launch the coding agent workspace. Chat is available in the side panel."
          action={
            project ? (
              <Button variant="accent" size="sm" onClick={handlePickCodeDir}>
                <FolderOpen size={12} />
                Choose folder
              </Button>
            ) : undefined
          }
          className="p-6"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-[var(--background)]">
      {/* ── Main layout row ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden flex-row">

        {/* Left pane — file tree. No border-r on desktop: the resize divider to
            its right provides the visible separator (avoids a double line). */}
        <div
          ref={treePaneRef}
          className="flex-shrink-0 flex flex-col overflow-hidden"
        >
          <FileTree project={project} />
        </div>

        {/* Left resize divider — a real 1.5-wide column with a centred 1px line.
            Washes to a 50% accent glow on hover to match every other resize
            handle in the app (see PreviewPane / UnifiedChatPanel). */}
        <div
          ref={leftDividerRef}
          className="group w-1.5 flex-shrink-0 cursor-col-resize bg-[var(--background)] flex justify-center hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)] transition-colors"
          role="separator"
          aria-label="Resize file tree"
        >
          <div className="w-px h-full bg-[var(--border)] group-hover:bg-transparent transition-colors" />
        </div>

        {/* Centre pane — tab bar + editor/diff */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Tab selector for editor / diff / git / architecture */}
          <div className="flex items-center gap-1 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
            <button
              onClick={() => setCentreTab("editor")}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-semibold transition-colors",
                centreTab === "editor"
                  ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              )}
            >
              Editor
            </button>
            {codeDirectory && (
              <button
                onClick={() => setCentreTab("diff")}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-semibold transition-colors",
                  centreTab === "diff"
                    ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                )}
              >
                Diff
              </button>
            )}
            {codeDirectory && (
              <button
                onClick={() => setCentreTab("git")}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-semibold transition-colors",
                  centreTab === "git"
                    ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                )}
              >
                Git
              </button>
            )}
            {codeDirectory && (
              <button
                onClick={() => setCentreTab("architecture")}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-semibold transition-colors",
                  centreTab === "architecture"
                    ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                )}
              >
                Architecture
              </button>
            )}
            <IconButton
              label="Project settings"
              onClick={() => setProjectSettingsOpen(true)}
              className="size-auto ml-auto p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]"
            >
              <Settings size={14} />
            </IconButton>
          </div>

          {/* Editor content — editor + contextual architecture sidebar (desktop) */}
          <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-row", centreTab !== "editor" && "hidden")}>
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <AgentEditor />
            </div>
            {codeDirectory && hasOpenFile && (
              <div className="hidden lg:flex">
                <ArchitectureSidebar />
              </div>
            )}
          </div>

          {/* Diff content */}
          {codeDirectory && (
            <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-col", centreTab !== "diff" && "hidden")}>
              <DiffViewer cwd={codeDirectory} />
            </div>
          )}

          {/* Git content */}
          {codeDirectory && (
            <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-col", centreTab !== "git" && "hidden")}>
              <GitView cwd={codeDirectory} />
            </div>
          )}

          {/* Architecture content */}
          {codeDirectory && (
            <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-col", centreTab !== "architecture" && "hidden")}>
              <ArchitectureView cwd={codeDirectory} />
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom terminal (only when a codeDirectory is set) ─────────────── */}
      {codeDirectory && (
        <>
          {/* Horizontal drag divider — a real 6px-tall row (no negative-margin
              overlap trick, so nothing can bleed across it) with a centred 1px
              line. Washes to a 50% accent glow on hover to match every other
              resize handle in the app. */}
          <div
            ref={bottomDividerRef}
            className="group h-1.5 flex-shrink-0 cursor-row-resize bg-[var(--background)] flex items-center hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)] transition-colors"
            role="separator"
            aria-label="Resize bottom terminal"
          >
            <div className="h-px w-full bg-[var(--border)] group-hover:bg-transparent transition-colors" />
          </div>
          <div className="flex-shrink-0 flex w-full">
            <AgentBottomTerminal cwd={codeDirectory} height={bottomHeight} />
          </div>
        </>
      )}

      {/* Project settings modal */}
      <ProjectSettingsModal open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)} />

    </div>
  );
}
