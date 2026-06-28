/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the project-creation portion of the workspace slice.
 *
 * Focus: the v2.3.2 fix that threads the chosen project icon through, plus the
 * optimistic state (project row + 5 default columns) created synchronously
 * before the IPC round-trip. Runs in the node test env where isElectron() is
 * false, so the IPC branch is skipped and only local state transitions run.
 */

import { describe, it, expect } from "vitest";
import { createWorkspaceSlice } from "./workspace";

function setup(initial: any = {}) {
  // Seed board state owned by other slices that createProject reads/writes
  // (columns lives in the board slice; projects is re-declared by this slice).
  let state: any = { persist: () => {}, projects: [], columns: [] };
  const mockSet = (updater: any) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...next };
  };
  const mockGet = () => state;
  const slice = createWorkspaceSlice(mockSet, mockGet, {} as any);
  // Slice first (it re-declares projects: []), then caller overrides so seeded
  // existing projects/columns survive.
  state = { ...state, ...slice, ...initial };
  return { get: () => state };
}

describe("createProject", () => {
  it("adds the project to state with the given name and workspace", async () => {
    const { get } = setup();
    const proj = await get().createProject("ws-1", "My Project");

    expect(proj.name).toBe("My Project");
    expect(proj.workspaceId).toBe("ws-1");
    expect(proj.status).toBe("active");
    expect(proj.priority).toBe("medium");
    expect(get().projects).toContainEqual(proj);
  });

  it("persists the chosen icon when provided (v2.3.2 onboarding fix)", async () => {
    const { get } = setup();
    const proj = await get().createProject("ws-1", "Iconic", "Rocket");

    expect(proj.icon).toBe("Rocket");
    // And the project stored in state carries the icon too.
    expect(get().projects.find((p: any) => p.id === proj.id)?.icon).toBe("Rocket");
  });

  it("omits the icon field entirely when no icon is provided", async () => {
    const { get } = setup();
    const proj = await get().createProject("ws-1", "No Icon");

    expect("icon" in proj).toBe(false);
  });

  it("creates exactly 5 default columns with correct types and order", async () => {
    const { get } = setup();
    const proj = await get().createProject("ws-1", "With Columns");

    const cols = get().columns.filter((c: any) => c.projectId === proj.id);
    expect(cols).toHaveLength(5);
    expect(cols.map((c: any) => c.type)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "review",
      "done",
    ]);
    expect(cols.map((c: any) => c.order)).toEqual([0, 1, 2, 3, 4]);
    // All columns belong to the same workspace as the project.
    expect(cols.every((c: any) => c.workspaceId === "ws-1")).toBe(true);
  });

  it("appends to existing projects and columns rather than replacing them", async () => {
    const existingProject = { id: "p-existing", workspaceId: "ws-1", name: "Old" };
    const existingColumn = { id: "c-existing", projectId: "p-existing", workspaceId: "ws-1", name: "X", type: "todo", order: 0 };
    const { get } = setup({ projects: [existingProject], columns: [existingColumn] });

    const proj = await get().createProject("ws-1", "New");

    expect(get().projects).toContainEqual(existingProject);
    expect(get().projects.some((p: any) => p.id === proj.id)).toBe(true);
    expect(get().columns).toContainEqual(existingColumn);
    expect(get().columns.filter((c: any) => c.projectId === proj.id)).toHaveLength(5);
  });

  it("assigns each created project a unique id", async () => {
    const { get } = setup();
    const a = await get().createProject("ws-1", "A");
    const b = await get().createProject("ws-1", "B");
    expect(a.id).not.toBe(b.id);
  });
});
