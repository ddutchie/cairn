"use client";

/**
 * AgentBottomTerminal — a plain interactive shell docked to the bottom of AgentView.
 *
 * - Spawns the user's login shell in the project's codeDirectory via agent:spawnShell.
 * - Reuses the existing agent:input / agent:resize / agent:data / agent:exit IPC
 *   channels so no new Electron-side plumbing is required beyond agent:spawnShell.
 * - Manages its own xterm Terminal instance (not registered in TerminalManager so
 *   AgentView's fitAll() doesn't interfere).
 * - Height is controlled by the parent via a draggable divider in AgentView.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, X, Plus, Bot } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";

interface AgentBottomTerminalProps {
  cwd: string;
  /** Controlled height in px — set by the parent drag divider */
  height: number;
  visible?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

let _shellCounter = 0;
function nextLabel() { return `Shell ${++_shellCounter}`; }

interface ShellTab {
  id: string;          // sessionId returned by spawnShell
  label: string;
  exited: boolean;
  /** Agent-owned PTY: read-only view, closing the tab never kills the process. */
  observed?: boolean;
}

/** Fixed width of model PTYs (see spawnShellPty) — observer tabs match it. */
const MODEL_PTY_COLS = 120;

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentBottomTerminal({ cwd, height, visible }: AgentBottomTerminalProps) {
  const fontScale = useCairnStore((s) => s.fontScale);

  const [tabs, setTabs]           = useState<ShellTab[]>([]);
  const [activeId, setActiveId]   = useState<string | null>(null);

  // StrictMode guard — prevents the double-invoke of the mount effect from
  // spawning two shells. Mirrors the initStarted pattern in SessionMount.
  const spawnStarted = useRef(false);

  // Session ids of observed (agent-owned) tabs — never killed / resized / typed into.
  const observedIds = useRef<Set<string>>(new Set());

  // Observed tabs keep the PTY's fixed column count and only fit rows;
  // a normal shell fits both (and reports the size to its PTY).
  const fitTerm = (id: string, m: { terminal: import("@xterm/xterm").Terminal; fitAddon: import("@xterm/addon-fit").FitAddon }) => {
    if (observedIds.current.has(id)) {
      const d = m.fitAddon.proposeDimensions();
      if (d && d.rows > 0) m.terminal.resize(MODEL_PTY_COLS, d.rows);
    } else {
      m.fitAddon.fit();
    }
  };

  // Agent tabs the user closed — ignore their further output.
  const dismissedIds = useRef<Set<string>>(new Set());

  // Raw output for observed (agent) tabs that arrived before their xterm mounted.
  const observedBuffers = useRef<Map<string, string>>(new Map());

  // containerRefs keyed by sessionId — the xterm Terminal mounts here
  const containerRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // xterm + fitAddon instances keyed by sessionId
  const termRefs = useRef<Map<string, {
    terminal: import("@xterm/xterm").Terminal;
    fitAddon: import("@xterm/addon-fit").FitAddon;
  }>>(new Map());

  // Unmount cleanup — kill all PTY sessions, dispose terminals and observers.
  // Capture ref.current into local variables so the closure sees stable values
  // (react-hooks/exhaustive-deps warns that ref.current can change by cleanup time).
  useEffect(() => {
    const terms = termRefs.current;
    const containers = containerRefs.current;
    const observed = observedIds.current;
    return () => {
      for (const [sid] of terms) {
        const container = containers.get(sid);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (container as any)?._cleanup?.();
        if (!observed.has(sid)) window.electron?.agent.kill(sid).catch(() => {});
      }
    };
  }, []);

  // Spawn the first shell on mount — guard against StrictMode double-invoke
  useEffect(() => {
    if (!window.electron) return;
    if (spawnStarted.current) return;
    spawnStarted.current = true;
    spawnShell();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Observe agent-owned terminals: list the live ones (with scrollback) on
  // mount, then follow spawn/exit. Output is buffered here until the tab's
  // xterm exists; initTerminal replays the buffer, then goes live.
  useEffect(() => {
    const api = window.electron?.agent;
    if (!api?.onModelTerminal) return;
    let cancelled = false;
    const addTab = (sessionId: string, cwd: string, scrollback = "") => {
      if (dismissedIds.current.has(sessionId)) return;
      if (scrollback) observedBuffers.current.set(sessionId, scrollback);
      const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? "shell";
      setTabs((prev) => prev.some((t) => t.id === sessionId)
        ? prev
        : [...prev, { id: sessionId, label: `Agent · ${base}`, exited: false, observed: true }]);
    };
    const off = api.onModelTerminal((e) => {
      if (e.type === "spawn") addTab(e.sessionId, e.cwd);
      else if (e.type === "data") {
        if (dismissedIds.current.has(e.sessionId)) return;
        const live = termRefs.current.get(e.sessionId);
        if (live) live.terminal.write(e.data);
        else observedBuffers.current.set(e.sessionId, (observedBuffers.current.get(e.sessionId) ?? "") + e.data);
      } else if (e.type === "exit") {
        termRefs.current.get(e.sessionId)?.terminal.writeln(`\r\n\x1b[33m[Process exited with code ${e.exitCode}]\x1b[0m`);
        setTabs((prev) => prev.map((t) => t.id === e.sessionId ? { ...t, exited: true } : t));
      }
    });
    void api.modelTerminals().then((res) => {
      if (cancelled) return;
      const list = (res as { data?: Array<{ sessionId: string; cwd: string; scrollback: string }> } | undefined)?.data
        ?? (Array.isArray(res) ? res : []);
      for (const m of list) addTab(m.sessionId, m.cwd, m.scrollback);
    }).catch(() => {});
    return () => { cancelled = true; off(); };
  }, []);

  async function spawnShell() {
    try {
      const result = await window.electron?.agent.spawnShell(cwd);
      if (!result?.sessionId) return;
      const tab: ShellTab = { id: result.sessionId, label: nextLabel(), exited: false };
      setTabs((prev) => [...prev, tab]);
      setActiveId(result.sessionId);
    } catch (e) {
      console.error("[AgentBottomTerminal] Failed to spawn terminal shell:", e);
    }
  }

  // Mount a new xterm terminal whenever a new tab is added
  useEffect(() => {
    for (const tab of tabs) {
      if (termRefs.current.has(tab.id)) continue; // already initialised
      const container = containerRefs.current.get(tab.id);
      if (!container) continue;
      initTerminal(tab.id, container, !!tab.observed);
    }
  }, [tabs]);

  // Refit active terminal when height, visibility, or active terminal changes
  useEffect(() => {
    if (!activeId) return;
    const fit = () => {
      const m = termRefs.current.get(activeId);
      if (m) {
        try { fitTerm(activeId, m); } catch { /* not yet measured */ }
      }
    };
    fit();
    // Also fit after a short delay to ensure DOM has settled
    const timer = setTimeout(fit, 100);
    return () => clearTimeout(timer);
  }, [height, activeId, visible]);

  // Update font size when the user changes the font scale setting
  useEffect(() => {
    for (const [id, m] of termRefs.current) {
      m.terminal.options.fontSize = Math.round(11 * fontScale);
      requestAnimationFrame(() => { try { fitTerm(id, m); } catch { /* ok */ } });
    }
  }, [fontScale]);

  async function initTerminal(sessionId: string, container: HTMLDivElement, observed = false) {
    const { Terminal }      = await import("@xterm/xterm");
    const { FitAddon }      = await import("@xterm/addon-fit");
    const { Unicode11Addon } = await import("@xterm/addon-unicode11");

    if (termRefs.current.has(sessionId)) return; // StrictMode double-invoke guard

    const cs = getComputedStyle(document.documentElement);
    const resolvedFont = cs.getPropertyValue("--font-mono").trim()
      || "ui-monospace, 'Cascadia Code', 'Fira Code', monospace";
    const scale    = parseFloat(cs.getPropertyValue("--font-scale").trim() || "1") || 1;
    const fontSize = Math.round(11 * scale);

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: !observed,
      disableStdin: observed,
      fontSize,
      fontFamily: resolvedFont,
      cols: observed ? MODEL_PTY_COLS : Math.max(40, Math.floor(container.offsetWidth / 8)),
      rows: Math.max(4,  Math.floor(container.offsetHeight / 17)),
      theme: {
        background:          cs.getPropertyValue("--background").trim()   || "#111111",
        foreground:          cs.getPropertyValue("--text-primary").trim() || "#e5e5e5",
        cursor:              cs.getPropertyValue("--accent").trim()        || "#6366f1",
        selectionBackground: cs.getPropertyValue("--accent-dim").trim()   || "#6366f133",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = "11";

    container.innerHTML = "";
    terminal.open(container);
    termRefs.current.set(sessionId, { terminal, fitAddon });

    if (observed) {
      observedIds.current.add(sessionId);
      // Agent PTY: replay what it printed before this tab existed, then go
      // live (later chunks are written directly by the observer effect).
      const backlog = observedBuffers.current.get(sessionId);
      if (backlog) terminal.write(backlog);
      observedBuffers.current.delete(sessionId);
    }

    // Initial fit via ResizeObserver (same pattern as SessionMount)
    const ro = new ResizeObserver(() => {
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.cols > 0 && dims.rows > 0) {
        fitTerm(sessionId, { terminal, fitAddon });
        ro.disconnect();
      }
    });
    ro.observe(container);
    setTimeout(() => ro.disconnect(), 2000);

    // Ongoing resize (height drag)
    const roOngoing = new ResizeObserver(() => {
      try { fitTerm(sessionId, { terminal, fitAddon }); } catch { /* ok */ }
    });
    roOngoing.observe(container);

    // Keystrokes → PTY
    if (!observed) terminal.onData((data: string) => window.electron?.agent.input(sessionId, data));

    // Resize → PTY
    if (!observed) terminal.onResize(({ cols, rows }: { cols: number; rows: number }) =>
      window.electron?.agent.resize(sessionId, cols, rows));

    // PTY output → terminal
    const offData = window.electron?.agent.onData(
      ({ sessionId: sid, data }: { sessionId: string; data: string }) => {
        if (sid !== sessionId) return;
        terminal.write(data);
      }
    );

    // PTY exit
    const offExit = window.electron?.agent.onExit(
      ({ sessionId: sid, exitCode }: { sessionId: string; exitCode: number }) => {
        if (observed || sid !== sessionId) return;
        terminal.writeln(`\r\n\x1b[33m[Process exited with code ${exitCode}]\x1b[0m`);
        setTabs((prev) => prev.map((t) => t.id === sessionId ? { ...t, exited: true } : t));
      }
    );

    // Cleanup stored so tab close can tear down
    (container as HTMLDivElement & { _cleanup?: () => void })._cleanup = () => {
      ro.disconnect();
      roOngoing.disconnect();
      offData?.();
      offExit?.();
      terminal.dispose();
      termRefs.current.delete(sessionId);
    };
  }

  function closeTab(sessionId: string) {
    // Closing an observed tab only detaches the view; the agent still owns the shell.
    if (!observedIds.current.has(sessionId)) window.electron?.agent.kill(sessionId).catch(() => {});
    if (observedIds.current.delete(sessionId)) dismissedIds.current.add(sessionId);
    observedBuffers.current.delete(sessionId);
    const container = containerRefs.current.get(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (container as any)?._cleanup?.();
    containerRefs.current.delete(sessionId);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== sessionId);
      if (activeId === sessionId) setActiveId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }

  return (
    <div
      className="flex flex-col bg-[var(--background)] overflow-hidden h-full md:h-auto w-full"
      style={typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches ? {} : { height }}
    >
      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 h-8 overflow-x-auto">
        <div className="flex items-center pl-2 pr-1 gap-0.5 flex-shrink-0">
          <TerminalIcon size={11} className="text-[var(--text-tertiary)]" />
        </div>

        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "group flex items-center gap-1.5 px-2.5 h-full border-r border-[var(--border)] cursor-pointer flex-shrink-0 select-none",
              tab.id === activeId
                ? "bg-[var(--background)] text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]",
            )}
            onClick={() => setActiveId(tab.id)}
          >
            {tab.observed && <Bot size={10} className="text-[var(--accent)]" />}
            <span className={cn("text-[0.714rem]", tab.exited && "opacity-50")}>
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--surface-3)] transition-all"
            >
              <X size={9} />
            </button>
          </div>
        ))}

        {/* New tab button */}
        <button
          onClick={spawnShell}
          className="flex items-center justify-center w-8 h-full flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
          title="New terminal"
        >
          <Plus size={11} />
        </button>
      </div>

      {/* Terminal containers — all mounted, inactive ones hidden via CSS */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(el) => {
              containerRefs.current.set(tab.id, el);
            }}
            className={cn(
              "absolute inset-0 overflow-hidden",
              tab.id !== activeId && "hidden",
            )}
            style={{ background: "var(--background)" }}
          />
        ))}
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full text-[0.714rem] text-[var(--text-tertiary)]">
            No terminal running
          </div>
        )}
      </div>
    </div>
  );
}
