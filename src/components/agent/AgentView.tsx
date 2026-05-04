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
import { FileTree } from "./FileTree";
import { AgentEditor } from "./AgentEditor";
import { AgentTerminalPane } from "./AgentTerminalPane";
import { DiffViewer } from "./DiffViewer";
import { TerminalManager } from "./TerminalManager";
import { cn } from "@/lib/utils";

const MIN_TREE_WIDTH = 160;
const MIN_TERMINAL_WIDTH = 280;
const DEFAULT_TREE_WIDTH = 220;
const DEFAULT_TERMINAL_WIDTH = 380;

type CentreTab = "editor" | "diff";

export function AgentView() {
  const { activeProjectId, projects } = useCairnStore();
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const codeDirectory = project?.codeDirectory ?? null;

  const [centreTab, setCentreTab] = useState<CentreTab>("editor");

  // DOM refs for the two resizable panes — widths are mutated directly,
  // never stored in React state, so no re-render occurs during drag.
  const treePaneRef     = useRef<HTMLDivElement>(null);
  const terminalPaneRef = useRef<HTMLDivElement>(null);

  // Set initial widths once on mount via DOM (avoids a React render cycle)
  useEffect(() => {
    if (treePaneRef.current)     treePaneRef.current.style.width     = `${DEFAULT_TREE_WIDTH}px`;
    if (terminalPaneRef.current) terminalPaneRef.current.style.width = `${DEFAULT_TERMINAL_WIDTH}px`;
  }, []);

  // ── Drag logic ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let dragging: "left" | "right" | null = null;
    let startX = 0;
    let startWidth = 0;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;

      if (dragging === "left" && treePaneRef.current) {
        const next = Math.max(MIN_TREE_WIDTH, startWidth + (e.clientX - startX));
        treePaneRef.current.style.width = `${next}px`;
      }

      if (dragging === "right" && terminalPaneRef.current) {
        const next = Math.max(MIN_TERMINAL_WIDTH, startWidth - (e.clientX - startX));
        terminalPaneRef.current.style.width = `${next}px`;
        // Fit all terminals synchronously — same tick as the DOM resize,
        // so xterm redraws cols/rows with no visible lag.
        TerminalManager.fitAll();
      }
    }

    function onMouseUp() {
      if (dragging) {
        // Final fit after drag ends
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

    function startRightDrag(e: MouseEvent) {
      dragging = "right";
      startX = e.clientX;
      startWidth = terminalPaneRef.current?.offsetWidth ?? DEFAULT_TERMINAL_WIDTH;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    const leftDivider  = document.getElementById("agent-divider-left");
    const rightDivider = document.getElementById("agent-divider-right");

    leftDivider?.addEventListener("mousedown",  startLeftDrag);
    rightDivider?.addEventListener("mousedown", startRightDrag);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);

    return () => {
      leftDivider?.removeEventListener("mousedown",  startLeftDrag);
      rightDivider?.removeEventListener("mousedown", startRightDrag);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  }, []);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-[var(--background)]">

      {/* Left pane — file tree */}
      <div
        ref={treePaneRef}
        className="flex-shrink-0 flex flex-col border-r border-[var(--border)] overflow-hidden"
      >
        <FileTree project={project} />
      </div>

      {/* Left resize divider */}
      <div
        id="agent-divider-left"
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent)] active:bg-[var(--accent)] transition-colors bg-transparent"
        role="separator"
        aria-label="Resize file tree"
      />

      {/* Centre pane — tab bar + editor/diff */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
          <button
            onClick={() => setCentreTab("editor")}
            className={cn(
              "px-2.5 py-0.5 rounded text-[0.714rem] transition-colors",
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
                "px-2.5 py-0.5 rounded text-[0.714rem] transition-colors",
                centreTab === "diff"
                  ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              )}
            >
              Diff
            </button>
          )}
        </div>

        {/* CSS-hide editor so CM6 stays mounted when diff is active */}
        <div className={cn("flex-1 min-h-0 overflow-hidden flex flex-col", centreTab !== "editor" && "hidden")}>
          <AgentEditor />
        </div>

        {centreTab === "diff" && codeDirectory && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <DiffViewer cwd={codeDirectory} />
          </div>
        )}
      </div>

      {/* Right resize divider */}
      <div
        id="agent-divider-right"
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent)] active:bg-[var(--accent)] transition-colors bg-transparent"
        role="separator"
        aria-label="Resize terminal pane"
      />

      {/* Right pane — terminal sessions */}
      <div
        ref={terminalPaneRef}
        className="flex-shrink-0 flex flex-col border-l border-[var(--border)] overflow-hidden"
      >
        <AgentTerminalPane />
      </div>

    </div>
  );
}
