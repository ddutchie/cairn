/**
 * Unit tests for subagent scope plumbing (children vs descendants).
 *
 * Fake Cordis context (no live model, no real sessions). Proves:
 *   - `listSubagentChildren` defaults to the direct-children runtime
 *     (`ctx.subagents.listChildren`) and never touches `listDescendants`;
 *   - scope `"descendants"` dispatches to `ctx.subagents.listDescendants`
 *     and carries the durable `parentId` / `depth` onto each entry;
 *   - the legacy `(parent, signal)` overload still reaches `listChildren`
 *     with the signal intact (backward compatibility);
 *   - `normalizeSubagentScope` (the IPC-boundary coercion the
 *     `subagent:list` handler applies) falls back to `"children"`;
 *   - bad-request validation still rejects before touching the context;
 *   - the IPC handler shape — scope passthrough plus the
 *     `{ok:true,value}|{ok:false,code,message}` envelope — round-trips.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./cordis-context", () => ({
  getContext: vi.fn(),
}));

import { getContext } from "./cordis-context";
import {
  listSubagentChildren,
  normalizeSubagentScope,
  type SubagentScope,
} from "./subagent-control";

const mockedGetContext = vi.mocked(getContext);

interface FakeCalls {
  listChildren: Array<[unknown, AbortSignal | undefined]>;
  listDescendants: Array<[unknown, AbortSignal | undefined]>;
}

function makeCtx(opts?: {
  liveIds?: string[];
  children?: unknown[];
  descendants?: unknown[];
  failWith?: unknown;
}) {
  const calls: FakeCalls = { listChildren: [], listDescendants: [] };
  const live = new Set(opts?.liveIds ?? []);
  const subagents = {
    listChildren: vi.fn(async (parent: unknown, signal?: AbortSignal) => {
      calls.listChildren.push([parent, signal]);
      if (opts?.failWith) throw opts.failWith;
      return opts?.children ?? [];
    }),
    listDescendants: vi.fn(async (root: unknown, signal?: AbortSignal) => {
      calls.listDescendants.push([root, signal]);
      if (opts?.failWith) throw opts.failWith;
      return opts?.descendants ?? [];
    }),
    interrupt: vi.fn(),
  };
  const agents = {
    get: (id: unknown) => (live.has(String(id)) ? { status: "running" } : undefined),
  };
  const ctx = {
    subagents,
    get: (key: string) => (key === "agents" ? agents : undefined),
  };
  mockedGetContext.mockResolvedValue(ctx as never);
  return { calls, subagents };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** Mirror of the `subagent:list` IPC handler body in
 *  electron/ipc/session-runtime-handlers.ts (scope passthrough + envelope),
 *  exercised here with fakes so the handler shape is pinned without Electron. */
async function fakeListHandler(req: { parentSessionId: string; scope?: unknown }) {
  const scope: SubagentScope = normalizeSubagentScope(req.scope);
  try {
    return { ok: true as const, value: await listSubagentChildren(req.parentSessionId, scope) };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "internal";
    return { ok: false as const, code, message: err instanceof Error ? err.message : "subagent control failed" };
  }
}

describe("normalizeSubagentScope", () => {
  it("passes descendants through and falls back to children", () => {
    expect(normalizeSubagentScope("descendants")).toBe("descendants");
    expect(normalizeSubagentScope("children")).toBe("children");
    expect(normalizeSubagentScope(undefined)).toBe("children");
    expect(normalizeSubagentScope("grandchildren")).toBe("children");
    expect(normalizeSubagentScope(null)).toBe("children");
  });
});

describe("listSubagentChildren scope dispatch", () => {
  it("defaults to listChildren and maps live activity + parentAvailable", async () => {
    const { calls } = makeCtx({
      liveIds: ["parent-1", "child-a"],
      children: [
        { id: "child-a", mode: "continuable", label: "research", hasChildren: true },
        { id: "child-b", mode: "one-shot", label: "fetch" },
      ],
    });
    const view = await listSubagentChildren("parent-1");
    expect(calls.listChildren).toHaveLength(1);
    expect(String(calls.listChildren[0]![0])).toBe("parent-1");
    expect(calls.listDescendants).toHaveLength(0);
    expect(view.parentAvailable).toBe(true);
    expect(view.entries).toEqual([
      expect.objectContaining({ id: "child-a", mode: "continuable", activity: "running", live: true, hasChildren: true }),
      expect.objectContaining({ id: "child-b", mode: "one-shot", activity: "inactive", live: false }),
    ]);
    // Children scope carries no tree position.
    for (const entry of view.entries) {
      expect(entry).not.toHaveProperty("depth");
      expect(entry).not.toHaveProperty("parentId");
    }
  });

  it("reports parentAvailable false when the parent agent is not live (both scopes)", async () => {
    makeCtx({ children: [], descendants: [] });
    await expect(listSubagentChildren("ghost", "children")).resolves.toMatchObject({ parentAvailable: false });
    await expect(listSubagentChildren("ghost", "descendants")).resolves.toMatchObject({ parentAvailable: false });
  });

  it("descendants scope calls listDescendants and attaches parentId/depth", async () => {
    const { calls } = makeCtx({
      liveIds: ["root-1"],
      descendants: [
        { id: "child-a", mode: "continuable", label: "research", parentId: "root-1", depth: 1, hasChildren: true },
        { id: "grand-a", mode: "continuable", label: "deep dive", parentId: "child-a", depth: 2 },
        { kind: "diagnostic", id: "broken", reason: "corrupt" },
      ],
    });
    const view = await listSubagentChildren("root-1", "descendants");
    expect(calls.listDescendants).toHaveLength(1);
    expect(String(calls.listDescendants[0]![0])).toBe("root-1");
    expect(calls.listChildren).toHaveLength(0);
    expect(view.parentAvailable).toBe(true);
    expect(view.entries).toEqual([
      expect.objectContaining({ id: "child-a", parentId: "root-1", depth: 1 }),
      expect.objectContaining({ id: "grand-a", parentId: "child-a", depth: 2 }),
      { kind: "diagnostic", id: "broken", reason: "corrupt" },
    ]);
  });

  it("keeps the legacy (parent, signal) overload on listChildren", async () => {
    const { calls } = makeCtx({ children: [{ id: "child-a", mode: "one-shot" }] });
    const controller = new AbortController();
    const view = await listSubagentChildren("parent-1", controller.signal);
    expect(calls.listChildren).toHaveLength(1);
    expect(calls.listChildren[0]![1]).toBe(controller.signal);
    expect(calls.listDescendants).toHaveLength(0);
    expect(view.entries).toHaveLength(1);
  });

  it("rejects bad ids before touching the context (both scopes)", async () => {
    const { calls } = makeCtx();
    await expect(listSubagentChildren("", "descendants")).rejects.toMatchObject({ code: "bad-request" });
    expect(mockedGetContext).not.toHaveBeenCalled();
    expect(calls.listChildren).toHaveLength(0);
    expect(calls.listDescendants).toHaveLength(0);
  });
});

describe("subagent:list handler shape (faked)", () => {
  it("passes scope through and keeps the ok envelope", async () => {
    const { calls } = makeCtx({
      liveIds: ["root-1"],
      descendants: [{ id: "grand-a", mode: "continuable", parentId: "child-a", depth: 2 }],
    });
    const res = await fakeListHandler({ parentSessionId: "root-1", scope: "descendants" });
    expect(res.ok).toBe(true);
    expect(calls.listDescendants).toHaveLength(1);
    if (res.ok) {
      expect(res.value.parentAvailable).toBe(true);
      expect(res.value.entries).toEqual([expect.objectContaining({ id: "grand-a", depth: 2 })]);
    }
  });

  it("omitted scope lists children (backward-compatible renderer)", async () => {
    const { calls } = makeCtx({ children: [{ id: "child-a", mode: "one-shot" }] });
    const res = await fakeListHandler({ parentSessionId: "parent-1" });
    expect(res.ok).toBe(true);
    expect(calls.listChildren).toHaveLength(1);
    expect(calls.listDescendants).toHaveLength(0);
  });

  it("control failures surface as {ok:false, code, message}", async () => {
    makeCtx({ failWith: Object.assign(new Error("boom"), { code: "NOT_RESUMABLE" }) });
    const res = await fakeListHandler({ parentSessionId: "parent-1", scope: "children" });
    expect(res).toMatchObject({ ok: false, code: "internal" });
    expect((res as { message?: string }).message).toBe("boom");
  });

  it("bad requests surface as {ok:false, code:'bad-request'}", async () => {
    const res = await fakeListHandler({ parentSessionId: "   ", scope: "descendants" });
    expect(res).toMatchObject({ ok: false, code: "bad-request" });
  });
});
