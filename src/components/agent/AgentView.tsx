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
import { AgentTerminalPane } from "./AgentTerminalPane";
import { AgentBottomTerminal } from "./AgentBottomTerminal";
import { DiffViewer } from "./DiffViewer";
import { TerminalManager } from "./TerminalManager";
import { cn } from "@/lib/utils";

const MIN_TREE_WIDTH = 160;
const MIN_TERMINAL_WIDTH = 280;
const DEFAULT_TREE_WIDTH = 220;
const DEFAULT_TERMINAL_WIDTH = 380;

const MIN_BOTTOM_HEIGHT = 80;
const MAX_BOTTOM_HEIGHT = 600;
const DEFAULT_BOTTOM_HEIGHT = 220;

type CentreTab = "editor" | "diff";

export function AgentView() {
  const { activeProjectId, projects } = useCairnStore(useShallow((s) => ({ activeProjectId: s.activeProjectId, projects: s.projects })));
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const codeDirectory = project?.codeDirectory ?? null;

  const [centreTab, setCentreTab] = useState<CentreTab>("editor");
  // Bottom terminal height lives in React state so AgentBottomTerminal re-renders with the new height
  const [bottomHeight, setBottomHeight] = useState(DEFAULT_BOTTOM_HEIGHT);

  // DOM refs for the two resizable panes — widths are mutated directly,
  // never stored in React state, so no re-render occurs during drag.
  const treePaneRef      = useRef<HTMLDivElement>(null);
  const terminalPaneRef  = useRef<HTMLDivElement>(null);
  const leftDividerRef   = useRef<HTMLDivElement>(null);
  const rightDividerRef  = useRef<HTMLDivElement>(null);
  const bottomDividerRef = useRef<HTMLDivElement>(null);

  // Set initial widths once on mount via DOM (avoids a React render cycle)
  useEffect(() => {
    if (treePaneRef.current)     treePaneRef.current.style.width     = `${DEFAULT_TREE_WIDTH}px`;
    if (terminalPaneRef.current) terminalPaneRef.current.style.width = `${DEFAULT_TERMINAL_WIDTH}px`;
  }, []);

  // ── Drag logic ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let dragging: "left" | "right" | "bottom" | null = null;
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

      if (dragging === "right" && terminalPaneRef.current) {
        const next = Math.max(MIN_TERMINAL_WIDTH, startWidth - (e.clientX - startX));
        terminalPaneRef.current.style.width = `${next}px`;
        TerminalManager.fitAll();
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

    function startRightDrag(e: MouseEvent) {
      dragging = "right";
      startX = e.clientX;
      startWidth = terminalPaneRef.current?.offsetWidth ?? DEFAULT_TERMINAL_WIDTH;
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
    const rightDivider  = rightDividerRef.current;
    const bottomDivider = bottomDividerRef.current;

    leftDivider?.addEventListener("mousedown",   startLeftDrag);
    rightDivider?.addEventListener("mousedown",  startRightDrag);
    bottomDivider?.addEventListener("mousedown", startBottomDrag);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);

    return () => {
      leftDivider?.removeEventListener("mousedown",   startLeftDrag);
      rightDivider?.removeEventListener("mousedown",  startRightDrag);
      bottomDivider?.removeEventListener("mousedown", startBottomDrag);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  // bottomHeight is read as startHeight only on mousedown — safe to omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-[var(--background)]">

      {/* ── Three-pane row ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left pane — file tree */}
        <div
          ref={treePaneRef}
          className="flex-shrink-0 flex flex-col border-r border-[var(--border)] overflow-hidden"
        >
          <FileTree project={project} />
        </div>

        {/* Left resize divider */}
        <div
          ref={leftDividerRef}
          className="w-0 flex-shrink-0 cursor-col-resize relative z-10"
          style={{ marginLeft: "-3px", marginRight: "-3px", padding: "0 3px" }}
          role="separator"
          aria-label="Resize file tree"
        />

        {/* Centre pane — tab bar + editor/diff */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="flex items-center gap-0.5 py-1 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
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
          ref={rightDividerRef}
          className="w-0 flex-shrink-0 cursor-col-resize relative z-10"
          style={{ marginLeft: "-3px", marginRight: "-3px", padding: "0 3px" }}
          role="separator"
          aria-label="Resize terminal pane"
        />

        {/* Right pane — agent terminal sessions */}
        <div
          ref={terminalPaneRef}
          className="flex-shrink-0 flex flex-col border-l border-[var(--border)] overflow-hidden"
        >
          <AgentTerminalPane />
        </div>
      </div>

      {/* ── Bottom terminal (only when a codeDirectory is set) ─────────────── */}
      {codeDirectory && (
        <>
          {/* Horizontal drag divider */}
          <div
            ref={bottomDividerRef}
            className="h-0 flex-shrink-0 cursor-row-resize relative z-10 border-t border-[var(--border)]"
            style={{ marginTop: "-3px", marginBottom: "-3px", padding: "3px 0" }}
            role="separator"
            aria-label="Resize bottom terminal"
          />
          <AgentBottomTerminal cwd={codeDirectory} height={bottomHeight} />
        </>
      )}

    </div>
  );
}
