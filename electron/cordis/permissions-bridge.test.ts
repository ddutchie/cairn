/**
 * Unit tests for the permissions surface (dsh-permission-presets → renderer
 * preset switcher). No live model, no shell:
 *   - `toPermissionsWire` maps the upstream `{options, currentValue}` select
 *     (including the derived `custom` row) and rejects malformed views;
 *   - `readPermissionsSnapshot` prefers the live projection view, falls back
 *     to a cold build from the service table, and reports `unavailable`
 *     when the service is inject-gated (no per-turn `shell` yet);
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
  mountPermissionsBridge,
  readPermissionsSnapshot,
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

  it("throws unavailable when the service is inject-gated (no shell yet)", async () => {
    const ctx = {
      sessions: { get: () => undefined },
      sessionProjections: { stateOf: () => undefined },
      // no permissionPresets — fiber still pending on per-turn `shell`
    };
    const err = await readPermissionsSnapshot(ctx as never, "sess-1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("unavailable");
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

  it("mount is idempotent per context", () => {
    const registry = fakeRegistry();
    const ctx = { sessionProjections: registry } as never;
    mountPermissionsBridge(ctx);
    mountPermissionsBridge(ctx);
    expect(registry.onChanged).toHaveBeenCalledTimes(1);
  });
});
