/**
 * subagent-control — host-side continuable-subagent controls for Cairn's UI.
 *
 * Upstream (`dsh-subagent`) owns the continuation manager; the model drives it
 * through `send_message` / `interrupt_agent` / `list_agents`. This module is
 * the HUMAN equivalent: the catalog popover and the per-trace message/Stop
 * actions call into these helpers over IPC (`subagent:list|interrupt|message`
 * in session-runtime-handlers.ts).
 *
 * Capability notes (mirror the web shell's `prompt()` contract):
 * - list: durable read via `ctx.subagents.listChildren()` (`children` scope)
 *   or `ctx.subagents.listDescendants()` (`descendants` scope, same breadth
 *   as the model-side `list_agents` scope param) + live activity
 *   sampled from the Agent registry, like upstream's catalogView. Works
 *   anytime — no live agent needed.
 * - interrupt: durable `{kind:"user", parentSessionId}` authority. Works
 *   anytime; an absent target is an accepted no-op.
 * - message: needs the EXACT LIVE parent agent (`queueHostSubagentPrompt`
 *   takes the Agent object, not an id) — chat sessions retain theirs, coding
 *   sessions only mid-turn. Fails closed with `parent-unavailable` otherwise.
 *   Delivered as a `{kind:"user"}` message (never impersonates an agent).
 */
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { queueHostSubagentPrompt } from "@deepseek-ai/dsh-subagent/internal";
import { getContext } from "./cordis-context";
import "./ctx-augment";

export type SubagentChildMode = "one-shot" | "continuable";
export type SubagentChildActivity = "running" | "inactive";

/** Listing breadth for the human catalog. `children` = direct children only;
 *  `descendants` = the full session-backed subtree (dsh `listDescendants`). */
export type SubagentScope = "children" | "descendants";

/**
 * Lenient scope coercion for the IPC boundary — anything that is not exactly
 * `"descendants"` falls back to direct children, so older renderers (which
 * send no scope) keep working.
 */
export function normalizeSubagentScope(value: unknown): SubagentScope {
  return value === "descendants" ? "descendants" : "children";
}

export interface SubagentChildView {
  id: string;
  mode: SubagentChildMode;
  label?: string;
  activity: SubagentChildActivity;
  /** Exact agent live in this process right now (running or idle). */
  live: boolean;
  hasChildren: boolean;
  /** Descendants scope only: durable direct parent of this candidate. */
  parentId?: string;
  /** Descendants scope only: edge distance from the requested root (direct children are 1). */
  depth?: number;
}

export interface SubagentDiagnosticView {
  kind: "diagnostic";
  id: string;
  reason: "corrupt" | "unsupported" | "unavailable";
}

export type SubagentCatalogEntry = SubagentChildView | SubagentDiagnosticView;

export interface SubagentCatalogView {
  entries: SubagentCatalogEntry[];
  /** Whether the exact parent agent is live (host messaging possible). */
  parentAvailable: boolean;
}

export type SubagentControlCode =
  | "parent-unavailable"
  | "not-resumable"
  | "unauthorized"
  | "delivery-unavailable"
  | "attachment-invalid"
  | "bad-request"
  | "cancelled"
  | "internal";

export class SubagentControlError extends Error {
  readonly code: SubagentControlCode;
  constructor(code: SubagentControlCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface SubagentRuntime {
  listChildren: (parent: unknown, signal?: AbortSignal) => Promise<unknown[]>;
  listDescendants: (root: unknown, signal?: AbortSignal) => Promise<unknown[]>;
  interrupt: (target: unknown, authority: unknown) => void;
}

interface AgentRegistry {
  get: (id: unknown) => { status?: unknown } | undefined;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new SubagentControlError("bad-request", `${field} must be a non-empty string`);
  }
  return value;
}

function subagentsOf(ctx: Context): SubagentRuntime {
  const subagents = (ctx as unknown as { subagents?: SubagentRuntime }).subagents;
  if (!subagents) throw new SubagentControlError("internal", "subagent service unavailable");
  return subagents;
}

/** Map a SubagentError code to the stable control vocabulary. */
function controlCodeOf(err: unknown): SubagentControlCode {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "NOT_RESUMABLE": return "not-resumable";
    case "UNAUTHORIZED": return "unauthorized";
    case "DRAINING":
    case "ACTIVATION_CLOSING":
    case "CONTINUATION_UNAVAILABLE":
    case "PERSISTENCE_UNAVAILABLE": return "delivery-unavailable";
    case "MODEL_DOES_NOT_SUPPORT_IMAGES": return "attachment-invalid";
    case "CANCELLED": return "cancelled";
    default: return "internal";
  }
}

/**
 * Durable subagent catalog for one parent session, with live activity
 * sampled from the Agent registry (mirrors upstream catalogView).
 *
 * Scope selects the breadth: `"children"` (default) lists direct children via
 * `ctx.subagents.listChildren()`; `"descendants"` lists the full
 * session-backed subtree via `ctx.subagents.listDescendants()` (same
 * projection-backed runtime as the model-side `list_agents` scope param —
 * ordinary sessions and one-shot children remain traversal nodes, each entry
 * carries its durable `parentId` and root-relative `depth`). `parentAvailable`
 * keeps the same meaning for both scopes: whether the exact parent agent is
 * live in this process (host messaging possible).
 */
export async function listSubagentChildren(
  parentSessionId: string,
  scope: SubagentScope | AbortSignal = "children",
  signal?: AbortSignal,
): Promise<SubagentCatalogView> {
  const resolvedScope = normalizeSubagentScope(typeof scope === "string" ? scope : "children");
  // Backward-compatible overload: listSubagentChildren(parent, signal).
  const resolvedSignal = (typeof scope === "string" ? signal : scope) as AbortSignal | undefined;
  const parent = SessionId(requireId(parentSessionId, "parentSessionId"));
  const ctx = await getContext();
  const subagents = subagentsOf(ctx);
  let entries: SubagentCatalogEntry[];
  try {
    const rows = (resolvedScope === "descendants"
      ? await subagents.listDescendants(parent, resolvedSignal)
      : await subagents.listChildren(parent, resolvedSignal)) as Array<{
      kind?: string; id?: unknown; mode?: SubagentChildMode; label?: string;
      activity?: SubagentChildActivity; hasChildren?: boolean; reason?: SubagentDiagnosticView["reason"];
      parentId?: unknown; depth?: unknown;
    }>;
    const agents = (ctx as unknown as { get?: (key: string) => AgentRegistry }).get?.("agents");
    entries = rows.map((row) => {
      if (row?.kind === "diagnostic") {
        return { kind: "diagnostic" as const, id: String(row.id ?? ""), reason: row.reason ?? "unavailable" };
      }
      const id = String(row.id ?? "");
      const liveStatus = agents?.get(SessionId(id))?.status;
      const view: SubagentChildView = {
        id,
        mode: row.mode ?? "one-shot",
        ...(row.label !== undefined ? { label: row.label } : {}),
        // Live driver status wins over the store-derived row, like upstream.
        activity: liveStatus === "running" ? "running" : "inactive",
        live: liveStatus !== undefined,
        hasChildren: row.hasChildren === true,
      };
      if (resolvedScope === "descendants") {
        if (row.parentId != null) view.parentId = String(row.parentId);
        if (typeof row.depth === "number") view.depth = row.depth;
      }
      return view;
    });
  } catch (err) {
    if (err instanceof SubagentControlError) throw err;
    throw new SubagentControlError("internal", err instanceof Error ? err.message : "subagent catalog read failed");
  }
  const agents = (ctx as unknown as { get?: (key: string) => AgentRegistry }).get?.("agents");
  return { entries, parentAvailable: agents?.get(parent) !== undefined };
}

/**
 * Stop one live continuable child's current turn. Fire-and-return (the target
 * may run briefly until it observes the cancel); inbox, descendants, and the
 * child itself are preserved. Absent targets are an accepted no-op.
 */
export async function interruptSubagentChild(
  parentSessionId: string,
  childId: string,
): Promise<{ accepted: true }> {
  const parent = SessionId(requireId(parentSessionId, "parentSessionId"));
  const child = SessionId(requireId(childId, "childId"));
  const ctx = await getContext();
  const subagents = subagentsOf(ctx);
  try {
    subagents.interrupt(child, { kind: "user", parentSessionId: parent });
  } catch (err) {
    if (err instanceof SubagentControlError) throw err;
    const code = (err as { code?: string })?.code;
    if (code === "UNAUTHORIZED") throw new SubagentControlError("unauthorized", `subagent does not belong to session ${parentSessionId}`);
    throw new SubagentControlError("internal", err instanceof Error ? err.message : "interrupt failed");
  }
  return { accepted: true as const };
}

/**
 * Deliver one human-authored message to a continuable direct child as its own
 * turn. Requires the exact live parent agent in this process (chat sessions
 * retain theirs; coding sessions only mid-turn) — otherwise fails closed with
 * `parent-unavailable` and the renderer should say so instead of hanging.
 */
export async function messageSubagentChild(
  parentSessionId: string,
  childId: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ messageId: string }> {
  const parentId = SessionId(requireId(parentSessionId, "parentSessionId"));
  const child = SessionId(requireId(childId, "childId"));
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new SubagentControlError("bad-request", "message text must be non-empty");
  }
  if (text.length > 8000) {
    throw new SubagentControlError("bad-request", "message text exceeds 8000 characters");
  }
  const ctx = await getContext();
  const subagents = subagentsOf(ctx);
  const parent = (ctx as unknown as { get?: (key: string) => AgentRegistry & { } }).get?.("agents")?.get(parentId) as
    | (object & { id?: unknown })
    | undefined;
  if (!parent) {
    throw new SubagentControlError(
      "parent-unavailable",
      "parent session is not live — resume the session (start a turn) and retry",
    );
  }
  try {
    const messageId = await queueHostSubagentPrompt(
      subagents as never,
      parent as never,
      child,
      [{ type: "text", text }],
      // Host-authored user message. Exactly {kind:"user"} — extra provenance
      // fields would ride the durable log and risk replay-schema drift.
      { kind: "user" } as never,
      signal ?? new AbortController().signal,
    );
    return { messageId: String(messageId) };
  } catch (err) {
    if (err instanceof SubagentControlError) throw err;
    throw new SubagentControlError(controlCodeOf(err), err instanceof Error ? err.message : "message delivery failed");
  }
}
