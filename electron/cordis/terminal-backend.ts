/**
 * terminal-backend — `ctx.terminals` backend over Cairn's EXISTING node-pty
 * session manager (`electron/lib/pty-sessions.ts`).
 *
 * This file builds NO new PTY infrastructure: spawn/validation/kill go
 * through the same shared session table as the renderer's bottom-terminal
 * tabs, so there is exactly one spawn path (login shell + project-boundary
 * fallback chain) and one kill path. The dsh `TerminalSessionService`
 * (mounted globally, see `cordis-context.ts`) owns owner-scoped ids,
 * publication, authorization, and awaited cleanup; this backend only
 * translates between that seam and the shared manager.
 *
 * Simplifications vs `dsh-terminal-bash` (deliberate — documented gaps):
 *   - No prompt-marker / foreground-pgid protocol. Readiness is
 *     output-silence (idleSilenceMs) with an absolute timeout; `signal()`
 *     targets the session leader, not a verified foreground group, and
 *     SIGKILL is rejected (use `terminal_close`).
 *   - `captureMotd` publishes on silence-after-output OR quiet timeout —
 *     a live-but-silent shell still publishes (bash would fail startup).
 *     Only an exited shell fails spawn.
 */

import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import { TerminalError } from "@deepseek-ai/dsh-terminal";
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from "@deepseek-ai/dsh-terminal";
import type { Database } from "better-sqlite3";
import {
  getPtySession,
  killPtySession,
  onPtySessionData,
  onPtySessionExit,
  spawnShellPty,
} from "./host-store";

/** Backend registry type selected by `terminal_open { type }`. */
export const CAIRN_TERMINAL_BACKEND_TYPE = "shell";

const DEFAULT_IDLE_SILENCE_MS = 1500;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_MOTD_TIMEOUT_MS = 2000;
const DEFAULT_MOTD_QUIET_MS = 300;
const DEFAULT_DISPOSE_GRACE_MS = 3000;
const POLL_INTERVAL_MS = 50;
const MAX_SCROLLBACK_LINES = 5000;
const MAX_SCROLLBACK_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8ByteLength(text) <= maxBytes) return { text, truncated: false };
  const chars = Array.from(text);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const next = utf8ByteLength(chars[start - 1] as string);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return { text: chars.slice(start).join(""), truncated: true };
}

/** Injectable PTY substrate. Production delegates to the shared manager. */
export interface PtyAdapter {
  spawn(cwd: string): Promise<{ sessionId: string; pid?: number }>;
  write(sessionId: string, data: string): void;
  /** Deliver a POSIX signal to the session leader (not verified foreground). */
  signal(sessionId: string, sig: string): void;
  kill(sessionId: string): void;
  onData(sessionId: string, cb: (data: string) => void): () => void;
  onExit(sessionId: string, cb: (e: { exitCode: number; signal?: number }) => void): () => void;
}

/** Production adapter: every op hits the shared `pty-sessions` table. */
export function createSharedPtyAdapter(db: Database): PtyAdapter {
  return {
    spawn: async (cwd: string) => {
      const { sessionId } = await spawnShellPty(db, cwd, { kind: "model" });
      return { sessionId, pid: getPtySession(sessionId)?.pty.pid };
    },
    write: (sessionId: string, data: string) => {
      getPtySession(sessionId)?.pty.write(data);
    },
    signal: (sessionId: string, sig: string) => {
      getPtySession(sessionId)?.pty.kill(sig);
    },
    kill: (sessionId: string) => {
      killPtySession(sessionId);
    },
    onData: (sessionId: string, cb: (data: string) => void) => onPtySessionData(sessionId, cb),
    onExit: (sessionId: string, cb: (e: { exitCode: number; signal?: number }) => void) =>
      onPtySessionExit(sessionId, cb),
  };
}

interface ActiveSend {
  startedAt: number;
  buffer: string;
  bufferTruncated: boolean;
  lastOutputAt: number;
  settle: (reason: TerminalWaitReason) => void;
  fail: (error: unknown) => void;
  done: Promise<TerminalSendResult>;
  finished: boolean;
  cancelRequested: boolean;
}

/** One live model PTY: bounded scrollback + exclusive sends over one adapter id. */
export class CairnPtySession implements TerminalBackendSession {
  motd = "";
  readonly pid?: number;
  private readonly adapter: PtyAdapter;
  private readonly sessionId: string;
  private readonly idleSilenceMs: number;
  private readonly sendTimeoutMs: number;
  private readonly disposeGraceMs: number;
  private buffer = "";
  private dropped = false;
  private statusValue: TerminalSessionStatus = { kind: "running" };
  private active: ActiveSend | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private exitWaiters: Array<() => void> = [];
  private readonly disposers: Array<() => void> = [];

  constructor(
    adapter: PtyAdapter,
    sessionId: string,
    pid?: number,
    opts: { idleSilenceMs?: number; sendTimeoutMs?: number; disposeGraceMs?: number } = {},
  ) {
    this.adapter = adapter;
    this.sessionId = sessionId;
    if (pid !== undefined) this.pid = pid;
    this.idleSilenceMs = opts.idleSilenceMs ?? DEFAULT_IDLE_SILENCE_MS;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.disposeGraceMs = opts.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
    this.disposers.push(
      adapter.onData(sessionId, (data) => this.appendOutput(data)),
      adapter.onExit(sessionId, (e) => this.onExit(e.exitCode, e.signal)),
    );
  }

  private appendOutput(data: string): void {
    if (data.length === 0) return;
    this.buffer += data;
    const lines = this.buffer.split("\n");
    if (lines.length > MAX_SCROLLBACK_LINES) {
      this.buffer = lines.slice(lines.length - MAX_SCROLLBACK_LINES).join("\n");
      this.dropped = true;
    }
    const tail = utf8Tail(this.buffer, MAX_SCROLLBACK_BYTES);
    this.buffer = tail.text;
    this.dropped = this.dropped || tail.truncated;
    this.appendToActive(data);
    if (this.active) this.active.lastOutputAt = Date.now();
  }

  private appendToActive(data: string): void {
    const op = this.active;
    if (!op || op.finished) return;
    op.buffer += data;
    const tail = utf8Tail(op.buffer, MAX_READ_BYTES);
    op.buffer = tail.text;
    op.bufferTruncated = op.bufferTruncated || tail.truncated;
  }

  private onExit(exitCode: number, signal?: number): void {
    if (this.statusValue.kind === "exited") return;
    // node-pty reports the signal as a numeric code; the dsh seam types it
    // as a name. Preserve the code at runtime (cast) rather than dropping it.
    const signalName = (signal ?? null) as unknown as NodeJS.Signals | null;
    this.statusValue = { kind: "exited", exitCode, signal: signalName };
    const op = this.active;
    if (op && !op.finished) op.settle("session_exit");
    for (const wake of this.exitWaiters.splice(0)) wake();
  }

  /** Capture startup output; resolves with whatever arrived ("" when silent). */
  async captureMotd(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    // Read status fresh on every check (never narrow `statusValue` across an
    // await — `onExit` mutates it from the PTY callback between polls).
    if (this.status().kind === "exited") throw new Error("PTY shell exited during startup");
    const start = Date.now();
    const quietMs = Math.min(DEFAULT_MOTD_QUIET_MS, timeoutMs);
    for (;;) {
      signal?.throwIfAborted();
      if (this.status().kind === "exited") throw new Error("PTY shell exited during startup");
      const elapsed = Date.now() - start;
      if (this.buffer.length > 0 && elapsed >= quietMs) {
        // One quiet window after first output is enough — the shell is alive
        // and printing; waiting the full prompt cycle would stall every open.
        await new Promise((r) => setTimeout(r, Math.min(quietMs, Math.max(0, timeoutMs - elapsed))));
        if (this.status().kind === "exited") throw new Error("PTY shell exited during startup");
        break;
      }
      if (elapsed >= timeoutMs) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    const tail = utf8Tail(this.buffer, MAX_READ_BYTES);
    this.motd = tail.text;
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error("PTY session is closing");
    if (this.statusValue.kind === "exited") throw new Error("PTY session has exited");
    if (this.active !== undefined) {
      throw new TerminalError("PTY session already has an active send", "SEND_ACTIVE");
    }
    if (request.signal?.aborted === true) throw new Error("PTY send aborted before write");

    let settleFn!: (reason: TerminalWaitReason) => void;
    let failFn!: (error: unknown) => void;
    const done = new Promise<TerminalSendResult>((resolve, reject) => {
      settleFn = (reason) => {
        const op = this.active;
        if (!op || op.finished) return;
        op.finished = true;
        this.clearTimers();
        if (this.active === op) this.active = undefined;
        resolve({
          viewport: op.buffer,
          waitReason: reason,
          sessionStatus: this.statusValue,
          truncated: op.bufferTruncated || this.dropped,
        });
      };
      failFn = (error: unknown) => {
        const op = this.active;
        if (!op || op.finished) return;
        op.finished = true;
        this.clearTimers();
        if (this.active === op) this.active = undefined;
        reject(error);
      };
    });
    const op: ActiveSend = {
      startedAt: Date.now(),
      buffer: "",
      bufferTruncated: false,
      lastOutputAt: Date.now(),
      settle: settleFn,
      fail: failFn,
      done,
      finished: false,
      cancelRequested: false,
    };
    this.active = op;

    if (request.signal !== undefined) {
      const onAbort = (): void => { this.cancelActive(); };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const prevSettle = op.settle;
      op.settle = (reason) => {
        request.signal?.removeEventListener("abort", onAbort);
        prevSettle(reason);
      };
      const prevFail = op.fail;
      op.fail = (error: unknown) => {
        request.signal?.removeEventListener("abort", onAbort);
        prevFail(error);
      };
    }
    this.deadlineTimer = setTimeout(() => {
      if (this.active === op && !op.finished) op.settle("timeout");
    }, this.sendTimeoutMs);
    this.schedulePoll();

    const operation: TerminalSendOperation = {
      done,
      readOutput: (): TerminalSendRead => {
        const delta = op.buffer;
        const truncated = op.bufferTruncated;
        op.buffer = "";
        op.bufferTruncated = false;
        return { delta, truncated };
      },
      cancel: (): boolean => this.cancelActive(),
    };

    try {
      this.adapter.write(this.sessionId, `${request.text}${request.submit ? "\r" : ""}`);
    } catch (error: unknown) {
      op.fail(error);
    }
    return operation;
  }

  private cancelActive(): boolean {
    const op = this.active;
    if (!op || op.finished) return false;
    op.cancelRequested = true;
    // No foreground-pgid interrupt protocol on the shared manager (see file
    // header): settle with what has arrived. Foreground callers map abort to
    // their own error; background jobs map cancel to killed via their flag.
    op.settle("timeout");
    return true;
  }

  private schedulePoll(): void {
    if (this.pollTimer !== undefined || this.active === undefined) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.pollReadiness();
    }, POLL_INTERVAL_MS);
  }

  private pollReadiness(): void {
    const op = this.active;
    if (!op || op.finished) return;
    if (this.statusValue.kind === "exited") {
      op.settle("session_exit");
      return;
    }
    if (Date.now() - op.lastOutputAt >= this.idleSilenceMs) {
      op.settle("inferred_idle");
      return;
    }
    this.schedulePoll();
  }

  private clearTimers(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const lines = this.buffer.length === 0 ? [] : this.buffer.split("\n");
    const totalLines = lines.length;
    const offset = request.offset ?? 0;
    const count = request.count ?? 500;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("PTY read offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("PTY read count must be a positive safe integer");
    }
    if (offset >= totalLines) {
      return { text: "", totalLines, lineBegin: offset, lineEnd: offset, truncated: this.dropped };
    }
    const end = totalLines - offset;
    const start = Math.max(0, end - count);
    const requested = lines.slice(start, end).join("\n");
    const bounded = utf8Tail(requested, MAX_READ_BYTES);
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split("\n").length;
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: this.dropped || bounded.truncated,
    };
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error("PTY session is closing");
    if (this.statusValue.kind === "exited") throw new Error("PTY session has exited");
    if (signal === "SIGKILL") {
      // Mirrors the tool contract ("Shell-targeted SIGKILL is rejected; use
      // terminal_close"): killing the session leader out from under the
      // registry would orphan the entry's cleanup fence.
      throw new Error("SIGKILL targets the shell itself — use terminal_close");
    }
    try {
      this.adapter.signal(this.sessionId, signal);
    } catch (error: unknown) {
      throw new Error(`PTY signal ${signal} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // No foreground-pgid verification on the shared manager (gap documented
    // in the file header): the target is the session leader's pid.
    return { delivered: true, targetPgid: this.pid ?? 0 };
  }

  status(): TerminalSessionStatus {
    return this.statusValue;
  }

  close(reason: string): Promise<void> {
    void reason;
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const op = this.active;
      if (op && !op.finished) op.settle("session_exit");
      try {
        this.adapter.kill(this.sessionId);
      } catch { /* best-effort — the process may already be gone */ }
      if (this.statusValue.kind === "exited") {
        this.disposeListeners();
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.exitWaiters = this.exitWaiters.filter((w) => w !== wake);
          resolve();
        }, this.disposeGraceMs);
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        this.exitWaiters.push(wake);
      });
      this.disposeListeners();
    })().catch((error: unknown) => {
      this.closePromise = undefined;
      this.closing = false;
      throw error;
    });
    return this.closePromise;
  }

  private disposeListeners(): void {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch { /* noop */ }
    }
  }
}

export interface CairnTerminalBackendOptions {
  /** Turn workspace: default cwd when `terminal_open` omits one. */
  defaultCwd: string;
  /**
   * Database handle for project-boundary cwd validation (explicit, like the
   * fs-sandbox `{ cwd }` + sandbox-policy `{ mode }` pair). Absent + no
   * injected adapter → spawn fails closed.
   */
  db?: Database;
  /** Direct substrate injection (unit tests). Wins over `db`. */
  adapter?: PtyAdapter;
  idleSilenceMs?: number;
  sendTimeoutMs?: number;
  motdTimeoutMs?: number;
  disposeGraceMs?: number;
}

/**
 * `ctx.terminals` backend over the shared node-pty manager. Registered
 * per coding turn (see `cordis-coding-tools.ts`) with the turn's cwd, so a
 * cwd-less `terminal_open` lands in the session workspace — never in the
 * app bundle dir or the user's home.
 */
export class CairnTerminalBackend implements TerminalBackend {
  readonly type = CAIRN_TERMINAL_BACKEND_TYPE;
  private readonly opts: CairnTerminalBackendOptions;

  constructor(opts: CairnTerminalBackendOptions) {
    this.opts = opts;
  }

  private resolveAdapter(): PtyAdapter {
    if (this.opts.adapter) return this.opts.adapter;
    if (this.opts.db) return createSharedPtyAdapter(this.opts.db);
    throw new Error("terminal backend: no database handle for cwd validation (spawn refused)");
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<CairnPtySession> {
    spec.signal?.throwIfAborted();
    const requested = spec.cwd !== undefined && spec.cwd.length > 0 ? spec.cwd : this.opts.defaultCwd;
    if (!requested) throw new Error("terminal backend: no cwd (request had none and no default was configured)");
    const adapter = this.resolveAdapter();
    // Boundary validation lives in the shared manager (`spawnShellPty` →
    // `assertWithinCodeDirectory`): a model-supplied cwd outside every
    // registered code directory throws here, fail-closed.
    const { sessionId, pid } = await adapter.spawn(requested);
    const session = new CairnPtySession(adapter, sessionId, pid, {
      idleSilenceMs: this.opts.idleSilenceMs,
      sendTimeoutMs: this.opts.sendTimeoutMs,
      disposeGraceMs: this.opts.disposeGraceMs,
    });
    try {
      spec.signal?.throwIfAborted();
      await session.captureMotd(this.opts.motdTimeoutMs ?? DEFAULT_MOTD_TIMEOUT_MS, spec.signal);
      spec.signal?.throwIfAborted();
      return session;
    } catch (error) {
      // Never leak the PTY when publication fails (matches the registry's
      // rollback contract for unpublished setup).
      try { await session.close("PTY startup failed"); } catch { /* best-effort */ }
      throw error;
    }
  }
}

export interface CairnTerminalBackendPluginConfig {
  /** Turn workspace (default cwd for cwd-less opens). */
  cwd: string;
  /** Database handle for cwd validation. Omit only when `adapter` is set. */
  db?: Database;
  /** Direct substrate injection (unit tests). */
  adapter?: PtyAdapter;
  idleSilenceMs?: number;
  sendTimeoutMs?: number;
  motdTimeoutMs?: number;
}

/**
 * Per-turn plugin: registers the Cairn backend on the global `terminals`
 * service. Mounted by `mountCodingStack` only (coding-turn capability, like
 * `tool-bash`) — never in chat turns. The returned disposer unregisters the
 * backend at turn end; live sessions are already closed by then via the
 * registry's owner cleanup (owner agent disposes before turn fibers unload).
 */
export function cairnTerminalBackendPlugin(
  ctx: Context,
  config: CairnTerminalBackendPluginConfig,
): () => void {
  const backend = new CairnTerminalBackend({
    defaultCwd: config.cwd,
    ...(config.db !== undefined ? { db: config.db } : {}),
    ...(config.adapter !== undefined ? { adapter: config.adapter } : {}),
    ...(config.idleSilenceMs !== undefined ? { idleSilenceMs: config.idleSilenceMs } : {}),
    ...(config.sendTimeoutMs !== undefined ? { sendTimeoutMs: config.sendTimeoutMs } : {}),
    ...(config.motdTimeoutMs !== undefined ? { motdTimeoutMs: config.motdTimeoutMs } : {}),
  });
  return ctx.terminals.registerBackend(backend);
}
cairnTerminalBackendPlugin.inject = ["terminals"];
