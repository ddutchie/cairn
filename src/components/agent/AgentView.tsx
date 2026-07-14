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
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { FileTree } from "./FileTree";
import { AgentEditor } from "./AgentEditor";
import { SessionPane } from "./SessionPane";
import { AgentBottomTerminal } from "./AgentBottomTerminal";
import { DiffViewer } from "./DiffViewer";
import { GitView } from "./GitView";
import { ArchitectureView } from "./ArchitectureView";
import { ArchitectureSidebar } from "./ArchitectureSidebar";
import { TerminalManager } from "./TerminalManager";
import { Bot, FolderOpen, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProjectSettingsModal } from "./ProjectSettingsModal";

const MIN_TREE_WIDTH = 160;
const DEFAULT_TREE_WIDTH = 220;

const MIN_BOTTOM_HEIGHT = 80;
const MAX_BOTTOM_HEIGHT = 600;
const DEFAULT_BOTTOM_HEIGHT = 220;

type CentreTab = "editor" | "diff" | "git" | "architecture";

export function AgentView() {
  const { activeProjectId, projects, updateProject } = useCairnStore(useShallow((s) => ({ activeProjectId: s.activeProjectId, projects: s.projects, updateProject: s.updateProject })));
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const codeDirectory = project?.codeDirectory ?? null;

  async function handlePickCodeDir() {
    if (!project) return;
    const result = await window.electron?.agent.pickDirectory() as { data: string | null } | undefined;
    if (result?.data) updateProject(project.id, { codeDirectory: result.data });
  }

  const [centreTab, setCentreTab] = useState<CentreTab>("editor");
  const [mobileTab, setMobileTab] = useState<"agent" | "files" | "editor" | "diff" | "git" | "architecture" | "terminal">("agent");
  // Bottom terminal height lives in React state so AgentBottomTerminal re-renders with the new height
  const [bottomHeight, setBottomHeight] = useState(DEFAULT_BOTTOM_HEIGHT);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);

  // DOM refs for the resizable tree pane — mutated directly,
  // never stored in React state, so no re-render occurs during drag.
  const treePaneRef      = useRef<HTMLDivElement>(null);
  const leftDividerRef   = useRef<HTMLDivElement>(null);
  const bottomDividerRef = useRef<HTMLDivElement>(null);

  const [isMobile, setIsMobile] = useState(false);

  // Set initial widths once on mount via DOM (avoids a React render cycle)
  useEffect(() => {
    if (treePaneRef.current) treePaneRef.current.style.width = `${DEFAULT_TREE_WIDTH}px`;

    const media = window.matchMedia("(max-width: 767px)");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobile(media.matches);
    const listener = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
    // Re-run when codeDirectory appears: the tree pane only mounts once a codebase
    // is connected, so an empty dep array would leave its width unset (the ref is
    // null at first mount when there's no codebase).
  }, [codeDirectory]);

  // ── Drag logic ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let dragging: "left" | "bottom" | null = null;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;

      if (dragging === "left" && treePaneRef.current) {
        const next = Math.max(MIN_TREE_WIDTH, startWidth + (e.clientX - startX));
        treePaneRef.current.style.width = `${next}px`;
      }

      if (dragging === "bottom") {
        // Dragging up increases height (mouse moves up = lower clientY)
        const next = Math.min(MAX_BOTTOM_HEIGHT, Math.max(MIN_BOTTOM_HEIGHT, startHeight - (e.clientY - startY)));
        setBottomHeight(next);
      }
    }

    function onMouseUp() {
      if (dragging) {
        TerminalManager.fitAll();
        dragging = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    }

    function startLeftDrag(e: MouseEvent) {
      dragging = "left";
      startX = e.clientX;
      startWidth = treePaneRef.current?.offsetWidth ?? DEFAULT_TREE_WIDTH;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    function startBottomDrag(e: MouseEvent) {
      dragging = "bottom";
      startY = e.clientY;
      // Read current height from DOM so subsequent drags start from the right value
      // rather than the stale React state captured at effect registration time.
      startHeight = (bottomDividerRef.current?.nextElementSibling as HTMLElement | null)?.offsetHeight
        ?? DEFAULT_BOTTOM_HEIGHT;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    const leftDivider   = leftDividerRef.current;
    const bottomDivider = bottomDividerRef.current;

    leftDivider?.addEventListener("mousedown",   startLeftDrag);
    bottomDivider?.addEventListener("mousedown", startBottomDrag);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);

    return () => {
      leftDivider?.removeEventListener("mousedown",   startLeftDrag);
      bottomDivider?.removeEventListener("mousedown", startBottomDrag);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
    // Re-run when the codebase becomes available: the divider elements only exist
    // in the DOM once `codeDirectory` is set (the no-codebase branch returns early),
    // so an empty dep array would register mousedown listeners against null refs and
    // drag-resize would never work. Keying on codeDirectory re-attaches them once
    // the resizable layout mounts.
  }, [codeDirectory]);

  // No codebase on this project — show only chat, not the coding-agent workspace.
  // Chat is provided by the RightPanel drawer (auto-opened on agent view in page.tsx)
  // on both desktop (side drawer) and mobile (full-screen overlay), so we must NOT
  // render a SessionPane here — doing so double-mounts ChatPanel/useChatStream and
  // causes duplicate assistant messages (both onDone subscriptions call addMessage).
  if (!codeDirectory) {
    return (
      <div className="flex flex-1 min-h-0 overflow-hidden bg-[var(--background)]">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-[var(--accent-dim)] border border-[color-mix(in_srgb,var(--accent)_20%,transparent)] flex items-center justify-center">
            <Bot size={20} className="text-[var(--accent)]" />
          </div>
          <div className="flex flex-col gap-1.5 max-w-xs">
            <p className="text-sm font-semibold text-[var(--text-primary)]">No codebase connected</p>
            <p className="text-xs text-[var(--text-tertiary)]">
              This project has no code directory. Set one to launch the coding agent workspace. Chat is available in the side panel.
            </p>
          </div>
          {project && (
            <button
              onClick={handlePickCodeDir}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <FolderOpen size={12} />
              Choose folder
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-[var(--background)]">
      {/* Mobile Tab Selector */}
      <div className="md:hidden flex items-center justify-between px-2 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto scrollbar-none">
          {[
            { id: "agent" as const, label: "Agent Console" },
            { id: "files" as const, label: "Files" },
            { id: "editor" as const, label: "Editor" },
            ...(codeDirectory ? [{ id: "diff" as const, label: "Diff" }] : []),
            ...(codeDirectory ? [{ id: "git" as const, label: "Git" }] : []),
            ...(codeDirectory ? [{ id: "architecture" as const, label: "Architecture" }] : []),
            ...(codeDirectory ? [{ id: "terminal" as const, label: "Terminal" }] : []),
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setMobileTab(t.id);
                setTimeout(() => TerminalManager.fitAll(), 50);
              }}
              className={cn(
                "px-3 py-1 rounded-md text-[0.786rem] font-medium transition-colors whitespace-nowrap",
                mobileTab === t.id
                  ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setProjectSettingsOpen(true)}
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors flex items-center justify-center ml-2 flex-shrink-0"
          title="Project Settings"
          aria-label="Project Settings"
        >
          <Settings size={14} />
        </button>
      </div>

      {/* ── Main layout row ── */}
      <div className={cn(
        "flex-1 min-h-0 overflow-hidden flex-col md:flex-row",
        mobileTab === "terminal" ? "hidden md:flex" : "flex"
      )}>

        {/* Left pane — file tree. No border-r on desktop: the resize divider to
            its right provides the visible separator (avoids a double line). */}
        <div
          ref={treePaneRef}
          className={cn(
            "flex-shrink-0 flex flex-col overflow-hidden",
            "w-full md:w-auto max-md:!w-full",
            mobileTab === "files" ? "flex flex-1" : "hidden md:flex"
          )}
        >
          <FileTree project={project} />
        </div>

        {/* Left resize divider — a real 1.5-wide column with a centred 1px line.
            Washes to a 50% accent glow on hover to match every other resize
            handle in the app (see PreviewPane / UnifiedChatPanel). */}
        <div
          ref={leftDividerRef}
          className="group w-1.5 flex-shrink-0 cursor-col-resize bg-[var(--background)] flex justify-center hidden md:flex hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)] transition-colors"
          role="separator"
          aria-label="Resize file tree"
        >
          <div className="w-px h-full bg-[var(--border)] group-hover:bg-transparent transition-colors" />
        </div>

        {/* Centre pane — tab bar + editor/diff */}
        <div className={cn(
          "flex-1 min-w-0 flex flex-col overflow-hidden",
          (mobileTab === "editor" || mobileTab === "diff" || mobileTab === "git" || mobileTab === "architecture") ? "flex h-full" : "hidden md:flex"
        )}>
          {/* Tab selector for editor / diff (only if not on mobile, since mobile has its own tabs) */}
          <div className="hidden md:flex items-center gap-1 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
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
            <button
              onClick={() => setProjectSettingsOpen(true)}
              className="ml-auto p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors flex items-center justify-center"
              title="Project Settings"
              aria-label="Project Settings"
            >
              <Settings size={14} />
            </button>
          </div>

          {/* Editor content — editor + contextual architecture sidebar (desktop) */}
          <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-row", centreTab !== "editor" && "md:hidden", mobileTab !== "editor" && "max-md:hidden")}>
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <AgentEditor />
            </div>
            {codeDirectory && (
              <div className="hidden lg:flex">
                <ArchitectureSidebar />
              </div>
            )}
          </div>

          {/* Diff content */}
          {codeDirectory && (
            <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-col", centreTab !== "diff" && "md:hidden", mobileTab !== "diff" && "max-md:hidden")}>
              <DiffViewer cwd={codeDirectory} />
            </div>
          )}

          {/* Git content */}
          {codeDirectory && (
            <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-col", centreTab !== "git" && "md:hidden", mobileTab !== "git" && "max-md:hidden")}>
              <GitView cwd={codeDirectory} />
            </div>
          )}

          {/* Architecture content */}
          {codeDirectory && (
            <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-col", centreTab !== "architecture" && "md:hidden", mobileTab !== "architecture" && "max-md:hidden")}>
              <ArchitectureView cwd={codeDirectory} />
            </div>
          )}
        </div>

        {/* Right pane — agent terminal sessions (only on mobile, as desktop uses RightPanel drawer) */}
        {isMobile && (
          <div
            className={cn(
              "w-full flex-col flex-1 min-h-0 overflow-hidden md:hidden",
              (mobileTab === "agent" || mobileTab === "terminal") ? "flex" : "hidden"
            )}
          >
            <SessionPane />
          </div>
        )}
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
            className="group h-1.5 flex-shrink-0 cursor-row-resize bg-[var(--background)] flex items-center hidden md:flex hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)] transition-colors"
            role="separator"
            aria-label="Resize bottom terminal"
          >
            <div className="h-px w-full bg-[var(--border)] group-hover:bg-transparent transition-colors" />
          </div>
          <div
            className={cn(
              "flex-shrink-0",
              mobileTab === "terminal" ? "flex flex-1 h-full w-full" : "hidden md:flex w-full",
            )}
          >
            <AgentBottomTerminal cwd={codeDirectory} height={bottomHeight} visible={mobileTab === "terminal"} />
          </div>
        </>
      )}

      {/* Project settings modal */}
      <ProjectSettingsModal open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)} />

    </div>
  );
}
