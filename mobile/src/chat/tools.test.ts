/**
 * Mobile built-in tool definitions: every schema well-formed, and the payload
 * sent with every agent request stays within budget. Native/RN modules are
 * mocked so the real TOOLS list loads under plain Node.
 */
import { describe, it, expect, vi } from "vitest";
import { encode } from "gpt-tokenizer";

const q = vi.hoisted(() => ({
  getNote: vi.fn(), getNoteForAgent: vi.fn(), getNoteRange: vi.fn(), getCard: vi.fn(),
  listColumns: vi.fn(), listCards: vi.fn(), listProjects: vi.fn((): Record<string, unknown>[] => []), searchTasks: vi.fn((): Record<string, unknown>[] => []),
  listReadyCards: vi.fn((): Record<string, unknown>[] => []), listCardsWithDueDates: vi.fn((): Record<string, unknown>[] => []),
  patchNote: vi.fn(() => ({ ok: true })), appendToNote: vi.fn(() => true),
  moveCardToColumn: vi.fn(), updateTask: vi.fn(), archiveCard: vi.fn(), tagTask: vi.fn(() => ({ id: "x", tagIds: [] })),
  linkNoteToTask: vi.fn(() => ({ linked: true })), unlinkNoteFromTask: vi.fn(() => ({ unlinked: true })),
  createTask: vi.fn(() => "new-card"), softDeleteNote: vi.fn(), deleteCard: vi.fn(),
  renameNote: vi.fn(() => ({ title: "t" })), moveNotesToFolder: vi.fn(() => 1), pinNote: vi.fn(), tagNote: vi.fn(() => ({ id: "x", tagIds: [] })),
}));
vi.mock("@/db/queries", () => q);
vi.mock("@/notes/embeddings", () => ({}));
vi.mock("@modules/apple-embeddings", () => ({ isAppleEmbeddingsSupported: () => false }));
vi.mock("./services", () => ({ serviceToolDefs: () => [] }));
vi.mock("./tool-toggles", () => ({ isToolEnabled: () => true }));
vi.mock("./mcp-store", () => ({ getCachedMcpToolDefs: () => [], getInstalledMcpServer: () => undefined, toRuntimeConfig: () => ({}) }));
vi.mock("./mcp-client", () => ({}));

const { TOOLS, WRITE_TOOL_NAMES, TOOL_MAP } = await import("./tools");
const run = (name: string, args: Record<string, unknown>) => TOOL_MAP.get(name)!.run(args) as Promise<Record<string, unknown>> | Record<string, unknown>;

/** Tokens for the tool list as the agent request carries it. */
function payloadTokens(): number {
  return encode(JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.jsonSchema })))).length;
}

describe("mobile built-in tools", () => {
  it("have unique names and well-formed object schemas", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      const s = t.jsonSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      expect(s.type, t.name).toBe("object");
      for (const r of s.required ?? []) expect(Object.keys(s.properties ?? {}), `${t.name}.${r}`).toContain(r);
    }
  });

  it("only list real tools as writes", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const w of WRITE_TOOL_NAMES) expect(names.has(w), w).toBe(true);
  });

  it("reports the payload size", () => {
    console.log(`mobile built-in tools: ${TOOLS.length} tools, ${payloadTokens()} tokens`);
    expect(payloadTokens()).toBeGreaterThan(0);
  });
});

describe("mobile consolidated tools route to the right queries", () => {
  it("get_item reads a note (outline by default, a line range on request) or a card", async () => {
    q.getNote.mockImplementation((id: string) => (id === "n1" ? { id: "n1" } : null));
    q.getNoteForAgent.mockReturnValue({ id: "n1", outline: [] });
    q.getNoteRange.mockReturnValue({ id: "n1", content: "slice" });
    q.getCard.mockImplementation((id: string) => (id === "c1" ? { id: "c1", title: "Card" } : null));
    expect(await run("get_item", { id: "n1" })).toMatchObject({ type: "note", outline: [] });
    expect(await run("get_item", { id: "n1", startLine: 3, endLine: 9 })).toMatchObject({ type: "note", content: "slice" });
    expect(q.getNoteRange).toHaveBeenCalledWith("n1", 3, 9);
    expect(await run("get_item", { id: "c1" })).toMatchObject({ type: "task", title: "Card" });
    expect((await run("get_item", { id: "zz" })).error).toMatch(/No note or task/);
  });

  it("edit_note patches with oldString and appends without it", async () => {
    await run("edit_note", { noteId: "n1", oldString: "a", newString: "b" });
    expect(q.patchNote).toHaveBeenCalledWith("n1", "a", "b");
    await run("edit_note", { noteId: "n1", newString: "tail" });
    expect(q.appendToNote).toHaveBeenCalledWith("n1", "tail");
  });

  it("update_tasks resolves columnType per card's project and reports per-card failures", async () => {
    q.getCard.mockImplementation((id: string) => (id === "c1" ? { id: "c1", title: "A", project_id: "p", column_id: "todo" } : null));
    q.listColumns.mockReturnValue([{ id: "todo", type: "todo" }, { id: "doing", type: "in_progress" }]);
    const res = await run("update_tasks", { cardIds: ["c1", "missing"], columnType: "in_progress", priority: "high" });
    expect(q.moveCardToColumn).toHaveBeenCalledWith("c1", "doing");
    expect(q.updateTask).toHaveBeenCalledWith("c1", { priority: "high" });
    expect(res.error).toMatch(/missing: Task not found/);
  });

  it("create_task defaults to the backlog column and applies due date, tags and links", async () => {
    q.listColumns.mockReturnValue([{ id: "todo", type: "todo" }, { id: "back", type: "backlog" }]);
    const res = await run("create_task", { projectId: "p", title: "Ship", dueDate: "2026-11-01", tagNames: ["x"], linkNoteIds: ["n1"] });
    expect(q.createTask).toHaveBeenCalledWith("p", "back", "Ship", { description: undefined, priority: undefined });
    expect(q.updateTask).toHaveBeenCalledWith("new-card", { dueDate: "2026-11-01" });
    expect(q.linkNoteToTask).toHaveBeenCalledWith("n1", "new-card");
    expect(res).toMatchObject({ id: "new-card", columnId: "back" });
  });

  it("search_tasks filter:'overdue' keeps open past-due cards only", async () => {
    q.listCardsWithDueDates.mockReturnValue([
      { id: "late", title: "Late", priority: "low", column_id: "todo", project_id: "p", due_date: "2000-01-01", is_done: 0 },
      { id: "doneLate", title: "Done", priority: "low", column_id: "done", project_id: "p", due_date: "2000-01-01", is_done: 1 },
      { id: "future", title: "Later", priority: "low", column_id: "todo", project_id: "p", due_date: "2999-01-01", is_done: 0 },
    ]);
    const res = await run("search_tasks", { query: "", filter: "overdue" }) as unknown as { id: string }[];
    expect(res.map((c) => c.id)).toEqual(["late"]);
  });

  it("delete routes by type", async () => {
    await run("delete", { type: "note", id: "n1" });
    expect(q.softDeleteNote).toHaveBeenCalledWith("n1");
    await run("delete", { type: "task", id: "c1" });
    expect(q.deleteCard).toHaveBeenCalledWith("c1");
  });
});
