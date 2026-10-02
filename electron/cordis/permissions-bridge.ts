/**
 * permissions-bridge — surface the dsh permission presets
 * (`ctx.permissionPresets`, `@deepseek-ai/dsh-permission-presets`) in the
 * Cairn UI.
 *
 * The model half is mounted post-bootstrap in `cordis-context.ts`
 * (PermissionPresetService — post-bootstrap because it injects `shell`, which
 * is only mounted per-turn by the coding stack; as a loader entry it would
 * stall `loader.await()`). The read side ships as the `permissions` session
 * projection (`{ options, currentValue }` select shape); the write side ships
 * as the `/permission <preset>` command.
 *
 * This module is the UI half:
 *   - `mountPermissionsBridge` subscribes the projection registry's change
 *     feed for the `permissions` key (same pattern as the session-title
 *     bridge's `onChanged` watch) and re-emits as `session:projection
 *     kind:"permissions"` for the renderer switcher. Singleton-subscribed
 *     (idempotent).
 *   - `readPermissionsSnapshot` serves the `session:permissions` IPC handler:
 *     live `stateOf` when the session is resident and the unit registered,
 *     else a cold build from the service catalog — or, while the service is
 *     inject-gated on the per-turn `shell` (idle / never-run sessions), the
 *     package's static preset table — with the current value from a queued
 *     switch, the session's logged knobs, or the fresh-session default.
 *   - `setPermissionPreset` / `applyPendingPermissionPreset`: switch live
 *     through the service, or queue while idle and apply on the next turn.
 *   - `toPermissionsWire` validates/normalises any candidate view into the
 *     renderer-safe select shape (or null). Pure — unit-tested without a ctx.
 */

import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets";
import {
  makeSessionProjection,
  type SessionProjectionKind,
} from "../../shared/agent/session-projection";

/** One preset row in the permissions select. */
export interface PermissionsOption {
  value: string;
  name: string;
  description?: string;
}

/** Renderer-safe `permissions` select view (mirrors the upstream wire view). */
export interface PermissionsSelect {
  options: PermissionsOption[];
  currentValue: string;
}

/** Upstream's derived not-a-preset marker — shown, never a switch target. */
export const PERMISSIONS_CUSTOM_VALUE = "custom";

/** Projection key of the upstream unit. */
export const PERMISSIONS_PROJECTION_KEY = "permissions";

/**
 * Validate/normalise a candidate `permissions` view into the renderer-safe
 * select shape. Returns null for anything that is not a well-formed
 * `{ options, currentValue }` select (unregistered unit, wrong key, garbage).
 * Copies defensively so renderer mutations cannot reach registry state.
 */
export function toPermissionsWire(view: unknown): PermissionsSelect | null {
  if (typeof view !== "object" || view === null) return null;
  const v = view as { options?: unknown; currentValue?: unknown };
  if (!Array.isArray(v.options) || typeof v.currentValue !== "string" || v.currentValue === "") return null;
  const options: PermissionsOption[] = [];
  for (const o of v.options) {
    const one = toPermissionsOption(o);
    if (!one) return null;
    options.push(one);
  }
  if (options.length === 0) return null;
  if (!options.some((o) => o.value === v.currentValue)) return null;
  return { options, currentValue: v.currentValue };
}

/** Validate/normalise one preset row (`{ value, name, description? }`). */
export function toPermissionsOption(raw: unknown): PermissionsOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as { value?: unknown; name?: unknown; description?: unknown };
  if (typeof o.value !== "string" || o.value === "") return null;
  if (typeof o.name !== "string" || o.name === "") return null;
  if (o.description !== undefined && typeof o.description !== "string") return null;
  return {
    value: o.value,
    name: o.name,
    ...(typeof o.description === "string" ? { description: o.description } : {}),
  };
}

/** Contexts already bridged — mount is idempotent across calls. */
const bridged = new WeakSet<object>();

export function __resetPermissionsBridgeForTest(): void {
  // WeakSet has no clear; tests use fresh fake contexts instead.
}

interface RegistryLike {
  onChanged?: (listener: (session: unknown, key: string, value: unknown) => void) => () => void;
  stateOf?: (session: unknown, key: string) => unknown;
}

interface SessionLike {
  id?: unknown;
}

interface CordisLike {
  sessions?: { get?: (id: unknown) => SessionLike | undefined };
  sessionProjections?: RegistryLike;
  permissionPresets?: {
    names?: unknown;
    defaultPreset?: unknown;
    optionOf?: (name: string) => unknown;
    current?: (session: unknown) => unknown;
  };
}

/** The service's selectable preset rows (`names` → `optionOf`), or [] when inactive. */
function catalogOptions(ctx: Context): PermissionsOption[] {
  const svc = (ctx as unknown as CordisLike).permissionPresets;
  const names = svc?.names;
  const optionOf = svc?.optionOf?.bind(svc);
  if (!Array.isArray(names) || typeof optionOf !== "function") return [];
  const options: PermissionsOption[] = [];
  for (const n of names) {
    if (typeof n !== "string" || n === "") continue;
    let raw: unknown;
    try {
      raw = optionOf(n);
    } catch {
      continue;
    }
    const one = toPermissionsOption(raw);
    if (one) options.push(one);
  }
  return options;
}

/**
 * dsh ≥0.2 projects `permissions` as `{ currentValue }` only — the option
 * list moved to the service's process-level catalog. Fill it back in so the
 * switcher gets the full select; the derived `custom` row is appended when
 * it is the current value. A view that already carries options passes as-is.
 */
function withCatalog(ctx: Context, view: unknown): unknown {
  if (typeof view !== "object" || view === null) return view;
  const v = view as { options?: unknown; currentValue?: unknown };
  if (Array.isArray(v.options) || typeof v.currentValue !== "string") return view;
  const options = catalogOptions(ctx);
  if (v.currentValue === PERMISSIONS_CUSTOM_VALUE && !options.some((o) => o.value === PERMISSIONS_CUSTOM_VALUE)) {
    const svc = (ctx as unknown as CordisLike).permissionPresets;
    const custom = toPermissionsOption(svc?.optionOf?.(PERMISSIONS_CUSTOM_VALUE)) ?? { value: PERMISSIONS_CUSTOM_VALUE, name: "Custom" };
    options.push(custom);
  }
  return { options, currentValue: v.currentValue };
}

function registryOf(ctx: Context): RegistryLike | undefined {
  return (ctx as unknown as CordisLike).sessionProjections;
}

async function emitPermissionsChange(ctx: Context, sessionId: unknown, value: unknown): Promise<void> {
  if (sessionId == null) return;
  const wire = toPermissionsWire(withCatalog(ctx, value));
  if (!wire) return;
  const { broadcastEvent } = await import("../ipc/registry");
  const kind: SessionProjectionKind = "permissions";
  broadcastEvent("session:projection", makeSessionProjection(String(sessionId), kind, wire));
}

/**
 * Subscribe the projection registry's change feed for the `permissions` key.
 * Idempotent per context; call once from `getContext()` post-bootstrap,
 * after the permission-presets service mount.
 */
export function mountPermissionsBridge(ctx: Context): void {
  if (bridged.has(ctx)) return;
  bridged.add(ctx);
  let registry: RegistryLike | undefined;
  try {
    registry = registryOf(ctx);
  } catch {
    registry = undefined;
  }
  if (!registry || typeof registry.onChanged !== "function") {
    console.warn("[permissions-bridge] sessionProjections unavailable — permissions UI will stay empty");
    return;
  }
  registry.onChanged((session: unknown, key: string, value: unknown) => {
    if (key !== PERMISSIONS_PROJECTION_KEY) return;
    const id = (session as SessionLike | undefined)?.id;
    if (id == null) return;
    void emitPermissionsChange(ctx, id, value);
  });
}

/**
 * Read the current permissions select for one session without requiring a
 * live agent turn. Prefers the live projection view (exact per-session knob
 * state); falls back to a cold build from the service preset table so a fresh
 * pane renders before any projection arrives. Throws an `unavailable`-coded
 * error when the service is not active (inject-gated on per-turn `shell`) —
 * the IPC layer converts this to the `{ok:false}` envelope and the switcher
 * hides.
 */
export async function readPermissionsSnapshot(
  ctx: Context,
  sessionId: string,
  opts?: { readEvents?: () => Promise<readonly { type: string; data?: unknown }[]> },
): Promise<PermissionsSelect> {
  const cordis = ctx as unknown as CordisLike;
  const stableId = SessionId(sessionId);
  // 1. Live view — exact per-session state when resident + registered.
  try {
    const live = cordis.sessions?.get?.(stableId);
    const registry = cordis.sessionProjections;
    // dsh ≥0.2: stateOf returns the folded knob state, not the view — the
    // service's current(session) derives the per-session preset name.
    const svc = cordis.permissionPresets;
    if (live && typeof svc?.current === "function") {
      const wire = toPermissionsWire(withCatalog(ctx, { currentValue: svc.current(live) }));
      if (wire) return wire;
    }
    if (live && registry && typeof registry.stateOf === "function") {
      const wire = toPermissionsWire(withCatalog(ctx, registry.stateOf(live as never, PERMISSIONS_PROJECTION_KEY as never)));
      if (wire) return wire;
    }
  } catch {
    /* fall through to the cold build */
  }
  // 2. Not resident (or the service is inject-gated on the per-turn `shell`,
  //    which is the normal state of an idle coding session — including a
  //    brand-new one before its first message). Build the select from the
  //    service catalog when live, else the package's static preset table, and
  //    resolve the current value from: a switch queued while idle → the
  //    session's own logged knobs → the default a fresh session is pinned to.
  const options = catalogOptions(ctx);
  const staticTable = staticPresetTable();
  const table = options.length > 0 ? null : staticTable;
  const rows = options.length > 0 ? options : staticOptions(staticTable);
  if (rows.length > 0) {
    let current = pendingPresets.get(sessionId);
    if (current === undefined && opts?.readEvents) {
      try {
        const events = await opts.readEvents();
        if (events.length > 0) current = derivePreset(foldPermissionKnobs(events), table ?? staticTable);
      } catch { /* fall back to the default below */ }
    }
    if (current === undefined) {
      const svcDefault = cordis.permissionPresets?.defaultPreset;
      current = typeof svcDefault === "string" ? svcDefault : rows[0].value;
    }
    const withCustom = current === PERMISSIONS_CUSTOM_VALUE && !rows.some((o) => o.value === current)
      ? [...rows, { value: PERMISSIONS_CUSTOM_VALUE, name: "Custom", description: "Current sandbox and approval settings do not match a preset." }]
      : rows;
    const wire = toPermissionsWire({ options: withCustom, currentValue: current });
    if (wire) return wire;
  }
  const err = new Error("permission presets unavailable (service not active — open a coding turn first)");
  (err as { code?: string }).code = "unavailable";
  throw err;
}

// ── Idle-session support ─────────────────────────────────────────────────────
// PermissionPresetService injects the per-turn `shell`, so between turns (and
// before a new session's first message) neither the service nor its
// `/permission` command exists. The switcher still needs to render and accept
// a choice: options come from the package's static preset table, and a switch
// made while idle is queued here and applied by the next coding turn right
// after the service mounts (`applyPendingPermissionPreset`).

/** One preset bundle from the dsh preset table. */
interface PresetSpecLike {
  sandbox: string;
  approval: string;
  name?: string;
  description?: string;
}

let staticTableCache: Record<string, PresetSpecLike> | null | undefined;

/** The package's default preset table (what cordis-context mounts with `{}`). */
export function staticPresetTable(): Record<string, PresetSpecLike> {
  if (staticTableCache !== undefined) return staticTableCache ?? {};
  try {
    const config = (PermissionPresetService as unknown as { Config: (c: unknown) => { presets?: Record<string, PresetSpecLike> } }).Config({});
    staticTableCache = config?.presets ?? null;
  } catch {
    staticTableCache = null;
  }
  return staticTableCache ?? {};
}

function staticOptions(table: Record<string, PresetSpecLike>): PermissionsOption[] {
  const out: PermissionsOption[] = [];
  for (const [value, spec] of Object.entries(table)) {
    const one = toPermissionsOption({ value, name: spec.name ?? value, ...(spec.description ? { description: spec.description } : {}) });
    if (one) out.push(one);
  }
  return out;
}

/** Folded permission knobs (mirrors the upstream `permissions` projection unit). */
export interface PermissionKnobs {
  preset: string | null;
  sandbox: string | null;
  approval: string | null;
}

/** Fold `permission/preset` / `sandbox/mode` / `approval/policy` (last write wins). */
export function foldPermissionKnobs(events: readonly { type: string; data?: unknown }[]): PermissionKnobs {
  const knobs: PermissionKnobs = { preset: null, sandbox: null, approval: null };
  for (const ev of events) {
    const d = ev.data as { preset?: unknown; mode?: unknown; policy?: unknown } | undefined;
    if (ev.type === "permission/preset" && typeof d?.preset === "string") knobs.preset = d.preset;
    else if (ev.type === "sandbox/mode" && typeof d?.mode === "string") knobs.sandbox = d.mode;
    else if (ev.type === "approval/policy" && typeof d?.policy === "string") knobs.approval = d.policy;
  }
  return knobs;
}

/**
 * Resolve the preset matching folded knobs — the upstream `derive` rule: a
 * still-matching last selection wins ties, else the first matching table
 * entry, else `custom`. Unset knobs default to the coding stack's
 * `workspace-write` sandbox and the `ask` approval policy.
 */
export function derivePreset(knobs: PermissionKnobs, table: Record<string, PresetSpecLike>): string {
  const sandbox = knobs.sandbox ?? "workspace-write";
  const approval = knobs.approval ?? "ask";
  const matches = (spec: PresetSpecLike | undefined) => spec !== undefined && spec.sandbox === sandbox && spec.approval === approval;
  if (knobs.preset !== null && matches(table[knobs.preset])) return knobs.preset;
  for (const [name, spec] of Object.entries(table)) if (matches(spec)) return name;
  return PERMISSIONS_CUSTOM_VALUE;
}

const pendingPresets = new Map<string, string>();

/** Test hook — drop queued switches. */
export function __resetPendingPresetsForTest(): void {
  pendingPresets.clear();
  staticTableCache = undefined;
}

/**
 * Switch a session's permission preset. Resident session with a live service
 * → applied immediately through the service (durable knob events, projection
 * broadcast). Otherwise the choice is queued for the next coding turn and
 * echoed to the renderer so the switcher reflects it right away.
 */
export async function setPermissionPreset(ctx: Context, sessionId: string, name: string): Promise<PermissionsSelect> {
  if (name === PERMISSIONS_CUSTOM_VALUE || name === "") {
    const err = new Error(`"${name}" is not a switchable preset`);
    (err as { code?: string }).code = "invalid";
    throw err;
  }
  const cordis = ctx as unknown as CordisLike & { permissionPresets?: { set?: (session: unknown, name: string) => void } };
  const svc = cordis.permissionPresets;
  const live = cordis.sessions?.get?.(SessionId(sessionId));
  const names = Array.isArray(svc?.names) ? svc!.names as string[] : Object.keys(staticPresetTable());
  if (!names.includes(name)) {
    const err = new Error(`unknown preset "${name}" (available: ${names.join(", ")})`);
    (err as { code?: string }).code = "invalid";
    throw err;
  }
  if (live && typeof svc?.set === "function") {
    svc.set(live, name);
    pendingPresets.delete(sessionId);
  } else {
    pendingPresets.set(sessionId, name);
  }
  const select = await readPermissionsSnapshot(ctx, sessionId);
  // A live switch broadcasts through the projection feed; a queued one has no
  // registry change to ride, so echo it here.
  if (!(live && typeof svc?.set === "function")) await emitPermissionsChange(ctx, sessionId, select);
  return select;
}

/**
 * Apply a switch queued while the session was idle. Call once per coding turn
 * after the agent is open (service mounted) and after Cairn's own per-turn
 * approval-policy write, so the user's explicit choice is the last word.
 */
export function applyPendingPermissionPreset(ctx: Context, sessionId: string, session: unknown): void {
  const name = pendingPresets.get(sessionId);
  if (name === undefined) return;
  const svc = (ctx as unknown as { permissionPresets?: { set?: (session: unknown, name: string) => void } }).permissionPresets;
  if (typeof svc?.set !== "function") return; // keep it queued for a turn that has the service
  pendingPresets.delete(sessionId);
  try {
    svc.set(session, name);
  } catch (err) {
    console.warn("[permissions-bridge] queued preset switch failed:", err instanceof Error ? err.message : err);
  }
}
