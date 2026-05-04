"use client";

/**
 * AgentView — full-screen three-pane coding agent workspace (⌘7).
 *
 * Layout:
 *   FileTree (left, resizable) │ AgentEditor (centre, flex-1) │ AgentTerminalPane (right, resizable)
 *
 * Pane widths are stored in local state (not persisted).
 * Sessions in TerminalManager survive navigation away and back.
 */

import { useRef, useState, useCallback, useEffect } from "react";
import { useCairnStore } from "@/store";
import { FileTree } from "./FileTree";
import { AgentEditor } from "./AgentEditor";
import { AgentTerminalPane } from "./AgentTerminalPane";

const MIN_TREE_WIDTH = 160;
const MIN_TERMINAL_WIDTH = 280;
const DEFAULT_TREE_WIDTH = 220;
const DEFAULT_TERMINAL_WIDTH = 380;

export function AgentView() {
  const { activeProjectId, projects } = useCairnStore();
  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const [terminalWidth, setTerminalWidth] = useState(DEFAULT_TERMINAL_WIDTH);

  // ── Left divider drag ──────────────────────────────────────────────────────
  const draggingLeft = useRef(false);
  const leftStartX = useRef(0);
  const leftStartWidth = useRef(0);

  const onLeftDividerMouseDown = useCallback((e: React.MouseEvent) => {
    draggingLeft.current = true;
    leftStartX.current = e.clientX;
    leftStartWidth.current = treeWidth;
    e.preventDefault();
  }, [treeWidth]);

  // ── Right divider drag ─────────────────────────────────────────────────────
  const draggingRight = useRef(false);
  const rightStartX = useRef(0);
  const rightStartWidth = useRef(0);

  const onRightDividerMouseDown = useCallback((e: React.MouseEvent) => {
    draggingRight.current = true;
    rightStartX.current = e.clientX;
    rightStartWidth.current = terminalWidth;
    e.preventDefault();
  }, [terminalWidth]);

  // ── Global mouse events ────────────────────────────────────────────────────
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (draggingLeft.current) {
        const delta = e.clientX - leftStartX.current;
        setTreeWidth(Math.max(MIN_TREE_WIDTH, leftStartWidth.current + delta));
      }
      if (draggingRight.current) {
        const delta = rightStartX.current - e.clientX;
        setTerminalWidth(Math.max(MIN_TERMINAL_WIDTH, rightStartWidth.current + delta));
      }
    }
    function onMouseUp() {
      draggingLeft.current = false;
      draggingRight.current = false;
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-[var(--background)]">
      {/* Left pane — file tree */}
      <div
        className="flex-shrink-0 flex flex-col border-r border-[var(--border)] overflow-hidden"
        style={{ width: treeWidth }}
      >
        <FileTree project={project} />
      </div>

      {/* Left resize divider */}
      <div
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent)] transition-colors bg-transparent"
        onMouseDown={onLeftDividerMouseDown}
        role="separator"
        aria-label="Resize file tree"
      />

      {/* Centre pane — file editor */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <AgentEditor />
      </div>

      {/* Right resize divider */}
      <div
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent)] transition-colors bg-transparent"
        onMouseDown={onRightDividerMouseDown}
        role="separator"
        aria-label="Resize terminal pane"
      />

      {/* Right pane — terminal sessions */}
      <div
        className="flex-shrink-0 flex flex-col border-l border-[var(--border)] overflow-hidden"
        style={{ width: terminalWidth }}
      >
        <AgentTerminalPane />
      </div>
    </div>
  );
}
