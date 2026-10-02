/**
 * Unit tests for the permissions surface (dsh-permission-presets → renderer
 * preset switcher). No live model, no shell:
 *   - `toPermissionsWire` maps the upstream `{options, currentValue}` select
 *     (including the derived `custom` row) and rejects malformed views;
 *   - `readPermissionsSnapshot` prefers the live projection view, falls back
 *     to a cold build from the service table, and serves the static preset
 *     table (current from queued switch / logged knobs / default) while the
 *     service is inject-gated (no per-turn `shell` yet);
 *   - `setPermissionPreset` applies live or queues while idle;
 *   - `mountPermissionsBridge` re-emits registry `permissions` changes as
 *     session:projection kind:"permissions" and ignores other keys.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";

const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } },
    ],
  },
}));

import {
  __resetPendingPresetsForTest,
  applyPendingPermissionPreset,
  mountPermissionsBridge,
  readPermissionsSnapshot,
  setPermissionPreset,
  toPermissionsOption,
  toPermissionsWire,
  PERMISSIONS_CUSTOM_VALUE,
  PERMISSIONS_PROJECTION_KEY,
} from "./permissions-bridge";

beforeEach(() => {
  sent.length = 0;
});

const SELECT = {
  options: [
    { value: "workspace-write", name: "workspace-write", description: "Write inside the workspace." },
    { value: "danger-full-access", name: "danger-full-access", description: "Full file access." },
  ],
  currentValue: "workspace-write",
};

describe("toPermissionsWire (projection→options mapping)", () => {
  it("passes a well-formed select through as a defensive copy", () => {
    const wire = toPermissionsWire(SELECT)!;
    expect(wire).toEqual(SELECT);
    expect(wire).not.toBe(SELECT);
    expect(wire.options).not.toBe(SELECT.options);
  });

  it("keeps the derived `custom` row when the service appends it", () => {
    const withCustom = {
      options: [...SELECT.options, { value: "custom", name: "Custom", description: "Does not match a preset." }],
      currentValue: "custom",
    };
    expect(toPermissionsWire(withCustom)).toEqual(withCustom);
    expect(PERMISSIONS_CUSTOM_VALUE).toBe("custom");
  });

  it("accepts options without a description", () => {
    expect(toPermissionsWire({
      options: [{ value: "a", name: "A" }],
      currentValue: "a",
    })).toEqual({ options: [{ value: "a", name: "A" }], currentValue: "a" });
  });

  it("rejects malformed views", () => {
    expect(toPermissionsWire(undefined)).toBeNull();
    expect(toPermissionsWire(null)).toBeNull();
    expect(toPermissionsWire({})).toBeNull();
    expect(toPermissionsWire({ options: [], currentValue: "a" })).toBeNull();
    expect(toPermissionsWire({ options: SELECT.options, currentValue: "" })).toBeNull();
    // currentValue must be one of the options
    expect(toPermissionsWire({ options: SELECT.options, currentValue: "nope" })).toBeNull();
    // bad rows
    expect(toPermissionsWire({ options: [{ value: "", name: "x" }], currentValue: "" })).toBeNull();
    expect(toPermissionsWire({ options: [{ value: "a" }], currentValue: "a" })).toBeNull();
    expect(toPermissionsWire({ options: [{ value: "a", name: "A", description: 7 }], currentValue: "a" })).toBeNull();
    expect(toPermissionsWire({ options: "presets", currentValue: "a" })).toBeNull();
  });

  it("toPermissionsOption validates single rows", () => {
    expect(toPermissionsOption({ value: "a", name: "A" })).toEqual({ value: "a", name: "A" });
    expect(toPermissionsOption({ value: "a", name: "A", description: "d" })).toEqual({ value: "a", name: "A", description: "d" });
    expect(toPermissionsOption(null)).toBeNull();
    expect(toPermissionsOption({ value: "", name: "A" })).toBeNull();
    expect(toPermissionsOption({ value: "a", name: "" })).toBeNull();
  });
});

describe("readPermissionsSnapshot", () => {
  it("prefers the live projection view", async () => {
    const ctx = {
      sessions: { get: () => ({ id: "sess-1" }) },
      sessionProjections: { stateOf: () => ({ ...SELECT }) },
    };
    await expect(readPermissionsSnapshot(ctx as never, "sess-1")).resolves.toEqual(SELECT);
  });

  it("cold-builds from the service table when no live view exists", async () => {
    const ctx = {
      sessions: { get: () => undefined },
      sessionProjections: { stateOf: () => { throw new Error("unit not registered"); } },
      permissionPresets: {
        names: ["workspace-write", "danger-full-access"],
        defaultPreset: "workspace-write",
        optionOf: (n: string) => SELECT.options.find((o) => o.value === n),
      },
    };
    await expect(readPermissionsSnapshot(ctx as never, "sess-1")).resolves.toEqual(SELECT);
  });

  it("live garbage falls through to the cold build", async () => {
    const ctx = {
      sessions: { get: () => ({ id: "sess-1" }) },
      sessionProjections: { stateOf: () => ({ bogus: true }) },
      permissionPresets: {
        names: ["workspace-write"],
        defaultPreset: "workspace-write",
        optionOf: () => ({ value: "workspace-write", name: "workspace-write" }),
      },
    };
    await expect(readPermissionsSnapshot(ctx as never, "sess-1")).resolves.toEqual({
      options: [{ value: "workspace-write", name: "workspace-write" }],
      currentValue: "workspace-write",
    });
  });

  const PRESETS = {
    names: ["workspace-write", "danger-full-access"],
    defaultPreset: "workspace-write",
    optionOf: (n: string) => SELECT.options.find((o) => o.value === n),
  };

  it("dsh 0.2: derives the live preset via current(session) and fills options from the catalog", async () => {
    const ctx = {
      sessions: { get: () => ({ id: "sess-1" }) },
      // 0.2 stateOf returns folded knobs, not a view
      sessionProjections: { stateOf: () => ({ sandbox: "danger-full-access", approval: "never", seeded: true }) },
      permissionPresets: { ...PRESETS, current: () => "danger-full-access" },
    };
    await expect(readPermissionsSnapshot(ctx as never, "sess-1")).resolves.toEqual({ ...SELECT, currentValue: "danger-full-access" });
  });

  // no permissionPresets — fiber still pending on per-turn `shell` (idle /
  // brand-new session before its first message)
  const idleCtx = () => ({
    sessions: { get: () => undefined },
    sessionProjections: { stateOf: () => undefined },
  });

  it("serves the static preset table for a never-run session (no shell yet)", async () => {
    const res = await readPermissionsSnapshot(idleCtx() as never, "sess-new");
    expect(res.options.map((o) => o.value)).toEqual(["workspace-write", "danger-full-access"]);
    expect(res.currentValue).toBe("workspace-write");
  });

  it("resolves an idle session's preset from its logged knobs", async () => {
    const readEvents = async () => [
      { type: "permission/preset", data: { preset: "workspace-write" } },
      { type: "sandbox/mode", data: { mode: "workspace-write" } },
      { type: "approval/policy", data: { policy: "ask" } },
      { type: "permission/preset", data: { preset: "danger-full-access" } },
      { type: "sandbox/mode", data: { mode: "danger-full-access" } },
      { type: "approval/policy", data: { policy: "never" } },
    ];
    const res = await readPermissionsSnapshot(idleCtx() as never, "sess-1", { readEvents });
    expect(res.currentValue).toBe("danger-full-access");
  });

  it("reports custom (as a disabled-row option) when logged knobs match no preset", async () => {
    const readEvents = async () => [
      { type: "sandbox/mode", data: { mode: "workspace-write" } },
      { type: "approval/policy", data: { policy: "never" } },
    ];
    const res = await readPermissionsSnapshot(idleCtx() as never, "sess-1", { readEvents });
    expect(res.currentValue).toBe(PERMISSIONS_CUSTOM_VALUE);
    expect(res.options.some((o) => o.value === PERMISSIONS_CUSTOM_VALUE)).toBe(true);
  });
});

describe("setPermissionPreset / applyPendingPermissionPreset", () => {
  beforeEach(() => __resetPendingPresetsForTest());

  it("queues a switch while idle, echoes it, and applies it once the service mounts", async () => {
    const ctx: Record<string, unknown> = {
      sessions: { get: () => undefined },
      sessionProjections: { stateOf: () => undefined },
    };
    const res = await setPermissionPreset(ctx as never, "sess-1", "danger-full-access");
    expect(res.currentValue).toBe("danger-full-access");
    expect(sent.some((m) => m.channel === "session:projection")).toBe(true);
    // snapshot keeps reporting the queued value until a turn applies it
    await expect(readPermissionsSnapshot(ctx as never, "sess-1")).resolves.toMatchObject({ currentValue: "danger-full-access" });

    const set = vi.fn();
    ctx.permissionPresets = { set };
    const session = { id: "sess-1" };
    applyPendingPermissionPreset(ctx as never, "sess-1", session);
    expect(set).toHaveBeenCalledWith(session, "danger-full-access");
    applyPendingPermissionPreset(ctx as never, "sess-1", session);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("applies immediately through the service when the session is live", async () => {
    const set = vi.fn();
    const live = { id: "sess-1" };
    const ctx = {
      sessions: { get: () => live },
      sessionProjections: { stateOf: () => undefined },
      permissionPresets: { names: ["workspace-write", "danger-full-access"], defaultPreset: "workspace-write", optionOf: (n: string) => SELECT.options.find((o) => o.value === n), current: () => "danger-full-access", set },
    };
    const res = await setPermissionPreset(ctx as never, "sess-1", "danger-full-access");
    expect(set).toHaveBeenCalledWith(live, "danger-full-access");
    expect(res.currentValue).toBe("danger-full-access");
  });

  it("rejects unknown and custom presets", async () => {
    const ctx = { sessions: { get: () => undefined } };
    await expect(setPermissionPreset(ctx as never, "sess-1", "nope")).rejects.toMatchObject({ code: "invalid" });
    await expect(setPermissionPreset(ctx as never, "sess-1", "custom")).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("mountPermissionsBridge", () => {
  function fakeRegistry() {
    const listeners = new Set<(session: unknown, key: string, value: unknown) => void>();
    return {
      listeners,
      onChanged: vi.fn((fn: (session: unknown, key: string, value: unknown) => void) => {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      }),
      emit: (session: unknown, key: string, value: unknown) => {
        for (const fn of listeners) fn(session, key, value);
      },
    };
  }

  function projections() {
    return sent
      .filter((s) => s.channel === "session:projection")
      .map((s) => s.payload as { sessionId: string; kind: string; data: unknown });
  }

  it("re-emits permissions changes with the wire shape, ignores other keys", async () => {
    const registry = fakeRegistry();
    mountPermissionsBridge({ sessionProjections: registry } as never);
    expect(registry.onChanged).toHaveBeenCalledTimes(1);

    registry.emit({ id: "sess-1" }, PERMISSIONS_PROJECTION_KEY, SELECT);
    registry.emit({ id: "sess-1" }, "title", "ignored");
    registry.emit({ id: "sess-1" }, PERMISSIONS_PROJECTION_KEY, { bogus: true });
    await vi.waitFor(() => expect(projections()).toHaveLength(1));
    const proj = projections()[0]!;
    expect(proj.kind).toBe("permissions");
    expect(proj.sessionId).toBe("sess-1");
    expect(proj.data).toEqual(SELECT);
  });

  it("dsh 0.2: fills options into a { currentValue }-only view from the service catalog", async () => {
    const registry = fakeRegistry();
    mountPermissionsBridge({
      sessionProjections: registry,
      permissionPresets: {
        names: ["workspace-write", "danger-full-access"],
        optionOf: (n: string) => n === "custom" ? { value: "custom", name: "Custom" } : SELECT.options.find((o) => o.value === n),
      },
    } as never);
    registry.emit({ id: "sess-2" }, PERMISSIONS_PROJECTION_KEY, { currentValue: "danger-full-access" });
    registry.emit({ id: "sess-3" }, PERMISSIONS_PROJECTION_KEY, { currentValue: "custom" });
    await vi.waitFor(() => expect(projections().filter((p) => p.sessionId !== "sess-1")).toHaveLength(2));
    const bySession = Object.fromEntries(projections().map((p) => [p.sessionId, p.data]));
    expect(bySession["sess-2"]).toEqual({ ...SELECT, currentValue: "danger-full-access" });
    expect(bySession["sess-3"]).toEqual({ options: [...SELECT.options, { value: "custom", name: "Custom" }], currentValue: "custom" });
  });

  it("mount is idempotent per context", () => {
    const registry = fakeRegistry();
    const ctx = { sessionProjections: registry } as never;
    mountPermissionsBridge(ctx);
    mountPermissionsBridge(ctx);
    expect(registry.onChanged).toHaveBeenCalledTimes(1);
  });
});
