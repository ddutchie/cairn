/**
 * session-export — Cairn host for dsh's session-log export capability
 * (`@deepseek-ai/dsh-session-log-export`).
 *
 * What upstream ships: a Web-only `/export` command ("Session log download
 * requested.") plus an authenticated `/api/session.export` ZIP route served
 * over the web shell's `connection` service (header action + Dialog live in
 * the dsh web client — `src/client/` — which Cairn's Next.js renderer does
 * not use). Electron has no `connection` service, so the upstream plugin
 * (`inject = ['commands', 'connection']`) cannot mount here — as a loader
 * entry it would stall `loader.await()` on the missing service (same reason
 * PermissionPresetService mounts post-bootstrap).
 *
 * What Cairn mounts instead: the SAME `/export` command name on the global
 * `ctx.commands` registry (inject `['commands']` only — ENTRY_LIST-resident),
 * whose handler performs the download locally: flush the live log, read the
 * backend's verbatim raw artifact, stream the fflate ZIP (session.jsonl +
 * descendants + media), and write it to disk. The command surfaces through the existing
 * `cordis:listCommands` merge, so the palette/command input picks `/export`
 * up with zero renderer changes (same free ride as `/feedback`).
 *
 * V1 scope: root session only (`includeDescendants: false`); the ZIP lands
 * under the HostStore-owned exports dir (userData/session-exports, per-
 * process tmpdir under VITEST) and the handler reports the absolute path.
 * Follow-ups (not this change): a header/menu download button in the
 * renderer, and an `/export` descendants flag.
 */

import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { CommandResult } from "@deepseek-ai/dsh-commands";
import type { SessionRawArtifact } from "@deepseek-ai/dsh-session-persistence";
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogExportDeps,
  type SessionLogExportReady,
} from "@deepseek-ai/dsh-session-log-export";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getHostStore } from "./host-store";

/** Cordis plugin name used by loader diagnostics. */
export const name = "session-export";

/** The command registry this export trigger registers into (ENTRY_LIST-resident). */
export const inject = ["commands"];

/** Register the global `/export` command. No config — the command takes none. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: "export",
    description: "Export this session log as a ZIP archive",
    handler: (invocation) => handleExportCommand(ctx, invocation),
  }), "cairn:session-export command");
}

interface ExportInvocationLike {
  readonly rawInput: string;
  readonly agent?: {
    readonly session?: { readonly header?: { readonly id?: unknown } };
    readonly ctx?: Context;
  };
}

/** Session id of the agent that received the command (the log to export). */
function readInvocationSessionId(invocation: ExportInvocationLike): string | undefined {
  const id = invocation.agent?.session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Stream one session-log ZIP to memory. The host never holds the whole
 * archive plus the whole log: entries stream through fflate incrementally
 * and only the collected chunks accumulate (bounded by the session size —
 * an export is an explicit user action, not a background task).
 */
export async function exportSessionLogBytes(
  ready: SessionLogExportReady,
  root: SessionRawArtifact,
  sessionId: ReturnType<typeof SessionId>,
  includeDescendants: boolean,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const stream = streamSessionLogZip(
    ready,
    root,
    sessionId,
    includeDescendants,
    DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
    signal,
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Export one session's log to a ZIP file: flush the live session, read the
 * canonical JSONL, stream the archive, write it via `writeFile`.
 *
 * Fail-closed: unknown session rejects (`Session not found.`), missing
 * services reject (`unavailable`) — never an empty or partial file, never a
 * hang (every await is a bounded persistence/store read).
 */
export async function exportSessionLog(
  deps: SessionLogExportDeps,
  sessionIdValue: string,
  writeFile: (filename: string, data: Uint8Array) => string,
  opts?: { includeDescendants?: boolean; signal?: AbortSignal },
): Promise<{ path: string; bytes: number }> {
  const sessionId = SessionId(sessionIdValue);
  if (!deps.sessionPersistence || !deps.sessionQuery || !deps.attachments) {
    throw new Error(
      "session log export is unavailable: missing session-query, session-persistence, or attachments service",
    );
  }
  // Raw-artifact backends (JSONL) export verbatim; a future backend without
  // per-session artifacts fails here instead of shipping a reconstruction.
  if (!deps.sessionPersistence.supportsRawArtifacts) {
    throw new Error(
      "session log export is unavailable: the persistence backend does not expose per-session raw artifacts",
    );
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  };
  const signal = opts?.signal ?? new AbortController().signal;
  await flushLiveSessionLog(deps, sessionId, signal);
  // `undefined` is absence (unknown session); anything else thrown is a
  // backend failure — both reject, never an empty file.
  const root = await deps.sessionPersistence.readRaw(sessionId, signal);
  if (root === undefined) throw new Error(`Session not found: "${sessionIdValue}"`);
  const bytes = await exportSessionLogBytes(
    ready,
    root,
    sessionId,
    opts?.includeDescendants ?? false,
    signal,
  );
  const filePath = writeFile(sessionLogZipFilename(sessionIdValue), bytes);
  return { path: filePath, bytes: bytes.byteLength };
}

/**
 * Resolve the export-file writer: the per-turn HostStore when one is
 * provided (agent ctx first, then the shared ctx — `cairnDbPlugin` mounts
 * per session/turn), otherwise a tmpdir fallback so the command still
 * fail-softs outside a session turn instead of erroring.
 */
function resolveWriter(
  ctx: Context,
  invocation: ExportInvocationLike,
): (filename: string, data: Uint8Array) => string {
  const agentCtx = invocation.agent?.ctx;
  const host = (agentCtx ? getHostStore(agentCtx) : undefined) ?? getHostStore(ctx);
  if (host) return (filename, data) => host.writeSessionExportFile(filename, data);
  return (filename, data) => {
    const dir = path.join(os.tmpdir(), "cairn-session-exports");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, path.basename(filename));
    fs.writeFileSync(filePath, data);
    return filePath;
  };
}

/** `/export` handler: root-session ZIP to disk, path back as command text. */
async function handleExportCommand(ctx: Context, invocation: {
  readonly rawInput: string;
  readonly agent?: ExportInvocationLike["agent"];
}): Promise<CommandResult> {
  if (invocation.rawInput.trim() !== "") {
    return { kind: "error", text: "The /export command does not accept a path." };
  }
  const sessionIdValue = readInvocationSessionId(invocation);
  if (!sessionIdValue) {
    return { kind: "error", text: "Session export needs a live session." };
  }
  try {
    const { path: filePath, bytes } = await exportSessionLog(
      sessionLogExportDeps(ctx),
      sessionIdValue,
      resolveWriter(ctx, invocation),
    );
    return { kind: "success", text: `Session log exported to ${filePath} (${bytes} bytes).` };
  } catch (err) {
    return { kind: "error", text: `Session export failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
