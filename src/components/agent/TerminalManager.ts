/**
 * TerminalManager — renderer-side singleton.
 *
 * Holds xterm.js Terminal instances keyed by sessionId. Instances persist
 * across Agent view navigations because this module is loaded once and
 * retained at module scope.
 *
 * The FitAddon is also stored so AgentTerminalPane can call fit() on resize
 * and tab switch.
 */

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface ManagedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  rawOutput: string; // accumulated raw output for DiffViewer
}

type OutputListener = (sessionId: string) => void;

class TerminalManagerClass {
  private sessions = new Map<string, ManagedTerminal>();
  private outputListeners = new Set<OutputListener>();

  set(sessionId: string, managed: ManagedTerminal): void {
    this.sessions.set(sessionId, managed);
  }

  get(sessionId: string): ManagedTerminal | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    const m = this.sessions.get(sessionId);
    if (m) {
      m.terminal.dispose();
      this.sessions.delete(sessionId);
    }
  }

  appendOutput(sessionId: string, data: string): void {
    const m = this.sessions.get(sessionId);
    if (!m) return;
    m.rawOutput += data;
    // Notify subscribers — they throttle internally if needed
    for (const fn of this.outputListeners) fn(sessionId);
  }

  getRawOutput(sessionId: string): string {
    return this.sessions.get(sessionId)?.rawOutput ?? "";
  }

  /** Subscribe to raw output changes. Returns an unsubscribe function. */
  onOutput(fn: OutputListener): () => void {
    this.outputListeners.add(fn);
    return () => this.outputListeners.delete(fn);
  }

  fit(sessionId: string): void {
    this.sessions.get(sessionId)?.fitAddon.fit();
  }

  fitAll(): void {
    for (const [, m] of this.sessions) {
      try { m.fitAddon.fit(); } catch { /* ignore */ }
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}

export const TerminalManager = new TerminalManagerClass();
