"use client";

/**
 * AgentTerminalPane — right pane of the Agent view.
 *
 * Renders xterm.js terminal sessions as tabs. Each session's Terminal
 * instance is held in TerminalManager (module-scope singleton), so sessions
 * survive navigation away from the Agent view.
 *
 * Inactive session divs are CSS-hidden (not unmounted) to preserve scroll history.
 */

import { useEffect, useRef, useCallback } from "react";
import { X, Terminal as TerminalIcon, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { TerminalManager } from "./TerminalManager";
import type { TerminalSession } from "@/store/slices/terminal-sessions";

// ── Single terminal session mount ─────────────────────────────────────────────

interface SessionMountProps {
  session: TerminalSession;
  isActive: boolean;
}

function SessionMount({ session, isActive }: SessionMountProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { markSessionExited } = useCairnStore();

  useEffect(() => {
    if (!containerRef.current) return;
    if (TerminalManager.has(session.sessionId)) {
      // Re-attach existing terminal to this container
      const m = TerminalManager.get(session.sessionId)!;
      containerRef.current.appendChild(m.terminal.element!);
      m.fitAddon.fit();
      return;
    }

    // Create new Terminal
    // Dynamic import to avoid SSR issues with xterm
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { Unicode11Addon } = await import("@xterm/addon-unicode11");

      // Resolve font family from CSS — xterm canvas cannot read CSS variables directly
      const resolvedFont = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono").trim() || "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace";

      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: resolvedFont,
        theme: {
          background: getComputedStyle(document.documentElement)
            .getPropertyValue("--background").trim() || "#1a1a1a",
          foreground: getComputedStyle(document.documentElement)
            .getPropertyValue("--text-primary").trim() || "#e5e5e5",
          cursor: getComputedStyle(document.documentElement)
            .getPropertyValue("--accent").trim() || "#6366f1",
          selectionBackground: getComputedStyle(document.documentElement)
            .getPropertyValue("--accent-dim").trim() || "#6366f133",
        },
      });

      const fitAddon = new FitAddon();
      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = "11";

      if (containerRef.current) {
        terminal.open(containerRef.current);
        fitAddon.fit();
      }

      TerminalManager.set(session.sessionId, { terminal, fitAddon, rawOutput: "" });

      // Forward keystrokes to PTY
      terminal.onData((data: string) => {
        window.electron?.agent.input(session.sessionId, data);
      });

      // Forward resize to PTY
      terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        window.electron?.agent.resize(session.sessionId, cols, rows);
      });

      // Wire PTY data stream
      const offData = window.electron?.agent.onData(
        ({ sessionId, data }: { sessionId: string; data: string }) => {
          if (sessionId !== session.sessionId) return;
          terminal.write(data);
          TerminalManager.appendOutput(sessionId, data);
        }
      );

      const offExit = window.electron?.agent.onExit(
        ({ sessionId, exitCode }: { sessionId: string; exitCode: number }) => {
          if (sessionId !== session.sessionId) return;
          markSessionExited(sessionId, exitCode);
          terminal.writeln(`\r\n\x1b[33m[Process exited with code ${exitCode}]\x1b[0m`);
        }
      );

      return () => {
        offData?.();
        offExit?.();
      };
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  // Fit on becoming active
  useEffect(() => {
    if (isActive) {
      setTimeout(() => TerminalManager.fit(session.sessionId), 50);
    }
  }, [isActive, session.sessionId]);

  return (
    <div
      className={cn("flex-1 min-h-0 overflow-hidden", !isActive && "hidden")}
      ref={containerRef}
      style={{ background: "var(--background)", height: "100%", width: "100%" }}
    />
  );
}

// ── AgentTerminalPane ─────────────────────────────────────────────────────────

export function AgentTerminalPane() {
  const {
    terminalSessions,
    activeSessionId,
    setActiveSession,
    removeTerminalSession,
  } = useCairnStore();

  const handleClose = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    TerminalManager.delete(sessionId);
    removeTerminalSession(sessionId);
    window.electron?.agent.kill(sessionId);
  }, [removeTerminalSession]);

  if (terminalSessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center p-4">
        <TerminalIcon size={24} className="text-[var(--text-tertiary)]" />
        <p className="text-xs text-[var(--text-tertiary)]">No agent sessions</p>
        <p className="text-xs text-[var(--text-tertiary)]">
          Spawn an agent from a task card on the Board
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center border-b border-[var(--border)] overflow-x-auto flex-shrink-0 bg-[var(--surface)]">
        {terminalSessions.map((session) => (
          <TerminalTab
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === activeSessionId}
            onActivate={() => setActiveSession(session.sessionId)}
            onClose={(e) => handleClose(session.sessionId, e)}
          />
        ))}
      </div>

      {/* Terminal mounts — each session always mounted, CSS-hidden when inactive */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--background)]">
        {terminalSessions.map((session) => (
          <SessionMount
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === activeSessionId}
          />
        ))}
      </div>
    </div>
  );
}

// ── TerminalTab ───────────────────────────────────────────────────────────────

interface TerminalTabProps {
  session: TerminalSession;
  isActive: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
}

function TerminalTab({ session, isActive, onActivate, onClose }: TerminalTabProps) {
  return (
    <button
      onClick={onActivate}
      role="tab"
      aria-selected={isActive}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 text-[0.714rem] whitespace-nowrap border-r border-[var(--border)] transition-colors flex-shrink-0 group",
        isActive
          ? "text-[var(--text-primary)] bg-[var(--background)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
      )}
    >
      {/* Status dot */}
      <CircleDot
        size={8}
        className={cn(
          "flex-shrink-0",
          session.status === "running"
            ? "text-[var(--success,#22c55e)]"
            : "text-[var(--text-tertiary)]"
        )}
      />

      {/* Label */}
      <span className="max-w-[120px] truncate">{session.taskTitle}</span>
      <span className="text-[var(--text-tertiary)]">{session.agentName}</span>

      {/* Exit code badge */}
      {session.status === "exited" && (
        <span className="text-[0.65rem] text-[var(--text-tertiary)]">
          [{session.exitCode}]
        </span>
      )}

      {/* Close */}
      <span
        role="button"
        aria-label={`Close ${session.taskTitle}`}
        onClick={onClose}
        className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--surface-2)] transition-all"
      >
        <X size={10} />
      </span>
    </button>
  );
}
