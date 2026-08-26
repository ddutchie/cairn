"use client";

import { useEffect, useRef } from "react";
import { useCairnStore } from "@/store";
import { TerminalManager } from "./TerminalManager";
import { cn } from "@/lib/utils";
import type { TerminalSession } from "@/types";

// xterm.css must be imported at module level.
import "@xterm/xterm/css/xterm.css";

interface SessionMountProps {
  session: TerminalSession;
  isActive: boolean;
}

export function SessionMount({ session, isActive }: SessionMountProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initStarted = useRef(false);
  const cleanupFns = useRef<Array<() => void>>([]);
  const markSessionExited = useCairnStore((s) => s.markSessionExited);
  const fontScale = useCairnStore((s) => s.fontScale);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Case 1: terminal already exists — re-attach and refit
    if (TerminalManager.has(session.sessionId)) {
      const m = TerminalManager.get(session.sessionId)!;
      if (m.terminal.element && !container.contains(m.terminal.element)) {
        container.innerHTML = "";
        container.appendChild(m.terminal.element);
      }
      TerminalManager.fit(session.sessionId);
      return;
    }

    // Case 2: StrictMode second-invoke guard
    if (initStarted.current) return;
    initStarted.current = true;

    // Case 3: create a new terminal
    let unmounted = false;
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { Unicode11Addon } = await import("@xterm/addon-unicode11");

      if (unmounted || !containerRef.current) return;

      const cs = getComputedStyle(document.documentElement);
      const resolvedFont = cs.getPropertyValue("--font-mono").trim()
        || "ui-monospace, 'Cascadia Code', 'Fira Code', monospace";
      const fs = parseFloat(cs.getPropertyValue("--font-scale").trim() || "1") || 1;
      const fontSize = Math.round(11 * fs);

      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontSize,
        fontFamily: resolvedFont,
        cols: Math.max(40, Math.floor(containerRef.current.offsetWidth / 8)),
        rows: Math.max(10, Math.floor(containerRef.current.offsetHeight / 17)),
        theme: {
          background: cs.getPropertyValue("--background").trim() || "#111111",
          foreground: cs.getPropertyValue("--text-primary").trim() || "#e5e5e5",
          cursor: cs.getPropertyValue("--accent").trim() || "#6366f1",
          selectionBackground: cs.getPropertyValue("--accent-dim").trim() || "#6366f133",
        },
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = "11";

      containerRef.current.innerHTML = "";
      terminal.open(containerRef.current);
      // WCAG: allow Escape to escape the xterm keyboard trap (Tab is sent to PTY by default)
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (event.key === "Escape") return false;
        return true;
      });

      TerminalManager.set(session.sessionId, { terminal, fitAddon, rawOutput: "" });

      const ro = new ResizeObserver(() => {
        const dims = fitAddon.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) {
          fitAddon.fit();
          ro.disconnect();
        }
      });
      ro.observe(containerRef.current);
      const roTimeout = setTimeout(() => ro.disconnect(), 2000);

      const d1 = terminal.onData((data: string) => {
        window.electron?.agent.input(session.sessionId, data);
      });
      const d2 = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        window.electron?.agent.resize(session.sessionId, cols, rows);
      });
      const offData = window.electron?.agent.onData(
        ({ sessionId: sid, data }: { sessionId: string; data: string }) => {
          if (sid !== session.sessionId) return;
          terminal.write(data);
          TerminalManager.appendOutput(sid, data);
        }
      );
      const offExit = window.electron?.agent.onExit(
        ({ sessionId: sid, exitCode }: { sessionId: string; exitCode: number }) => {
          if (sid !== session.sessionId) return;
          markSessionExited(sid, exitCode);
          terminal.writeln(`\r\n\x1b[33m[Process exited with code ${exitCode}]\x1b[0m`);
        }
      );

      cleanupFns.current = [
        () => { ro.disconnect(); clearTimeout(roTimeout); },
        () => d1.dispose(),
        () => d2.dispose(),
        () => offData?.(),
        () => offExit?.(),
      ];
    })();

    return () => {
      unmounted = true;
      cleanupFns.current.forEach((fn) => fn());
      cleanupFns.current = [];
      initStarted.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  useEffect(() => {
    if (isActive) TerminalManager.fit(session.sessionId);
  }, [isActive, session.sessionId]);

  useEffect(() => {
    const m = TerminalManager.get(session.sessionId);
    if (!m) return;
    m.terminal.options.fontSize = Math.round(11 * fontScale);
    const raf = requestAnimationFrame(() => TerminalManager.fit(session.sessionId));
    return () => cancelAnimationFrame(raf);
  }, [fontScale, session.sessionId]);

  return (
    <div
      className={cn("flex-1 min-h-0 overflow-hidden relative", !isActive && "hidden")}
      ref={containerRef}
      role="application"
      aria-label={`Terminal: ${session.taskTitle}`}
      aria-roledescription="terminal"
      style={{ background: "var(--background)", height: "100%", width: "100%" }}
    />
  );
}
