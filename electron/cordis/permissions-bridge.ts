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
 *     else a cold build from the service table (`names` + `defaultPreset`)
 *     for fresh sessions, else an `unavailable` error (service inject-gated
 *     on per-turn `shell` — the switcher hides until then).
 *   - `toPermissionsWire` validates/normalises any candidate view into the
 *     renderer-safe select shape (or null). Pure — unit-tested without a ctx.
 */

import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
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
  };
}

function registryOf(ctx: Context): RegistryLike | undefined {
  return (ctx as unknown as CordisLike).sessionProjections;
}

async function emitPermissionsChange(sessionId: unknown, value: unknown): Promise<void> {
  if (sessionId == null) return;
  const wire = toPermissionsWire(value);
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
    void emitPermissionsChange(id, value);
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
export async function readPermissionsSnapshot(ctx: Context, sessionId: string): Promise<PermissionsSelect> {
  const cordis = ctx as unknown as CordisLike;
  const stableId = SessionId(sessionId);
  // 1. Live view — exact per-session state when resident + registered.
  try {
    const live = cordis.sessions?.get?.(stableId);
    const registry = cordis.sessionProjections;
    if (live && registry && typeof registry.stateOf === "function") {
      const wire = toPermissionsWire(registry.stateOf(live as never, PERMISSIONS_PROJECTION_KEY as never));
      if (wire) return wire;
    }
  } catch {
    /* fall through to the cold build */
  }
  // 2. Cold build from the service table (no per-session overrides yet).
  try {
    const svc = cordis.permissionPresets;
    const names = svc?.names;
    const fallback = svc?.defaultPreset;
    const optionOf = svc?.optionOf?.bind(svc);
    if (Array.isArray(names) && typeof fallback === "string" && typeof optionOf === "function") {
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
      const wire = toPermissionsWire({ options, currentValue: fallback });
      if (wire) return wire;
    }
  } catch {
    /* fall through to unavailable */
  }
  const err = new Error("permission presets unavailable (service not active — open a coding turn first)");
  (err as { code?: string }).code = "unavailable";
  throw err;
}
