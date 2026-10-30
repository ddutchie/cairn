/**
 * Persistent model shells over Cairn's shared node-pty manager (the same one
 * the bottom-terminal tabs use, so these also show up there). A terminal
 * belongs to the session that opened it. Output is kept as plain text.
 */
import type { Database } from "better-sqlite3";
import { getSandboxMode } from "./host-store";
import { getPtySession, killPtySession, onPtySessionData, onPtySessionExit, spawnShellPty } from "../lib/pty-sessions";

const MAX_SCROLLBACK = 200_000;
const POLL_MS = 50;
export const DEFAULT_IDLE_MS = 1_500;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The PTY substrate; production uses the shared manager, tests inject a fake. */
export interface PtyAdapter {
  spawn(cwd: string): Promise<{ sessionId: string }>;
  write(id: string, data: string): void;
  signal(id: string, sig: string): void;
  kill(id: string): void;
  onData(id: string, cb: (data: string) => void): () => void;
  onExit(id: string, cb: (e: { exitCode: number }) => void): () => void;
}

export function sharedPtyAdapter(db: Database): PtyAdapter {
  return {
    spawn: async (cwd) => ({ sessionId: (await spawnShellPty(db, cwd, { kind: "model", sandbox: { mode: getSandboxMode() } })).sessionId }),
    write: (id, data) => { getPtySession(id)?.pty.write(data); },
    signal: (id, sig) => { getPtySession(id)?.pty.kill(sig); },
    kill: (id) => killPtySession(id),
    onData: (id, cb) => onPtySessionData(id, cb),
    onExit: (id, cb) => onPtySessionExit(id, cb),
  };
}

const CONTROL = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
const PARTIAL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?)?$/;

/** Plain text of one chunk, plus any escape sequence cut off at its end (prepend it to the next chunk). */
export function stripControl(data: string): { text: string; pending: string } {
  const partial = PARTIAL.exec(data);
  const pending = partial ? partial[0] : "";
  const complete = pending ? data.slice(0, -pending.length) : data;
  return { text: complete.replace(CONTROL, "").replace(/\r+\n/g, "\n").replace(/\r/g, ""), pending };
}

export interface TerminalInfo { id: string; cwd: string; alive: boolean; exitCode?: number }

interface Term extends TerminalInfo {
  owner: string;
  adapterId: string;
  text: string;
  /** Characters of `text` already returned by a read or send. */
  cursor: number;
  lastOutputAt: number;
  pending: string;
  dispose(): void;
}

export class TerminalRegistry {
  private readonly terms = new Map<string, Term>();
  private n = 0;

  constructor(private readonly pty: () => PtyAdapter) {}

  async open(owner: string, cwd: string): Promise<TerminalInfo> {
    const pty = this.pty();
    const { sessionId } = await pty.spawn(cwd);
    const id = `term-${++this.n}`;
    const term: Term = { id, owner, adapterId: sessionId, cwd, alive: true, text: "", cursor: 0, lastOutputAt: Date.now(), pending: "", dispose: () => undefined };
    const offData = pty.onData(sessionId, (data) => {
      const { text, pending } = stripControl(term.pending + data);
      term.pending = pending;
      if (!text) return;
      term.text += text;
      term.lastOutputAt = Date.now();
      if (term.text.length > MAX_SCROLLBACK) {
        const cut = term.text.length - MAX_SCROLLBACK;
        term.text = term.text.slice(cut);
        term.cursor = Math.max(0, term.cursor - cut);
      }
    });
    const offExit = pty.onExit(sessionId, ({ exitCode }) => { term.alive = false; term.exitCode = exitCode; });
    term.dispose = () => { offData(); offExit(); };
    this.terms.set(id, term);
    return this.info(term);
  }

  private info({ id, cwd, alive, exitCode }: Term): TerminalInfo { return { id, cwd, alive, ...(exitCode !== undefined ? { exitCode } : {}) }; }

  private get(owner: string, id: string): Term {
    const t = this.terms.get(id);
    if (!t || t.owner !== owner) throw new Error(`No terminal ${id} in this session.`);
    return t;
  }

  list(owner: string): TerminalInfo[] {
    return [...this.terms.values()].filter((t) => t.owner === owner).map((t) => this.info(t));
  }

  /** Output since the last read (or send). */
  read(owner: string, id: string, opts: { all?: boolean } = {}): { text: string; alive: boolean; exitCode?: number } {
    const t = this.get(owner, id);
    const text = opts.all ? t.text : t.text.slice(t.cursor);
    t.cursor = t.text.length;
    return { text, alive: t.alive, exitCode: t.exitCode };
  }

  /** Type into a terminal, then return what it printed until it went quiet (or the timeout). */
  async send(owner: string, id: string, input: string, opts: { idleMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ text: string; alive: boolean; exitCode?: number; timedOut: boolean }> {
    const t = this.get(owner, id);
    if (!t.alive) throw new Error(`Terminal ${id} has exited.`);
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    t.cursor = t.text.length;
    const started = Date.now();
    t.lastOutputAt = started;
    this.pty().write(t.adapterId, input);
    let timedOut = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const now = Date.now();
      if (!t.alive || opts.signal?.aborted) break;
      if (now - t.lastOutputAt >= idleMs && t.text.length > t.cursor) break;
      if (now - started >= timeoutMs) { timedOut = true; break; }
    }
    return { ...this.read(owner, id), timedOut };
  }

  signal(owner: string, id: string, sig: string): void {
    const t = this.get(owner, id);
    this.pty().signal(t.adapterId, sig);
  }

  close(owner: string, id: string): void {
    const t = this.get(owner, id);
    t.dispose();
    t.alive = false;
    this.pty().kill(t.adapterId);
    this.terms.delete(id);
  }

  /** Quit: close every terminal whoever owns it. */
  closeEvery(): void {
    for (const t of [...this.terms.values()]) this.close(t.owner, t.id);
  }

  closeAll(owner: string): void {
    for (const t of [...this.terms.values()]) if (t.owner === owner) this.close(owner, t.id);
  }
}
