import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConversationToolCall } from "./ConversationToolCall";
import type { ConversationToolCall as ToolCall } from "@/lib/conversation/message";

let nextCall = 0;
// A fresh id per call: open state is remembered by call id.
function call(over: Partial<ToolCall>): ToolCall {
  return { name: "tool", label: "tool", ok: true, callId: `c${++nextCall}`, ...over };
}

function renderCall(toolCall: ToolCall) {
  return render(<ConversationToolCall toolCall={toolCall} />, { wrapper: TooltipProvider });
}

/** Cards start collapsed; open one the way a user does. */
function renderOpen(toolCall: ToolCall) {
  const view = renderCall(toolCall);
  fireEvent.click(screen.getByTestId("cairn-tool-summary").closest("button")!);
  return view;
}

describe("Cairn tool card", () => {
  it("renders a Cairn data tool as a collapsed 'Cairn · action' card", () => {
    renderCall(call({ name: "get_today", args: { date: "2026-11-18" }, output: "{}" }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toBe("Cairn · Read the Today brief for 2026-11-18");
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Arguments")).toBeNull();
  });

  it("expands to labelled Arguments and Result panels", async () => {
    renderCall(call({ name: "get_today", args: { date: "2026-11-18" }, output: JSON.stringify({ headline: "Hi" }) }));
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
  });

  it("shows the error text for a failed call", async () => {
    renderCall(call({ name: "update_tasks", ok: false, args: { cardIds: ["x"] }, error: "Card not found" }));
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("Card not found").length).toBeGreaterThan(0);
  });

  it("leaves non-Cairn tools on the standard chip", () => {
    renderCall(call({ name: "bash", args: { command: "ls" }, output: "x" }));
    expect(screen.queryByTestId("cairn-tool-card")).toBeNull();
  });
});

describe("Cairn tool views", () => {
  it("shows a writing-style addition as a + line instead of the raw JSON", () => {
    const { container } = renderOpen(call({
      name: "update_user_writing_style",
      args: { section: "5", content: "Plain hyphens" },
      output: JSON.stringify({ ok: true, updated: true, section: "5", content: "Plain hyphens" }),
    }));
    expect(screen.getByText("5 Punctuation")).toBeTruthy();
    expect(container.textContent).toContain("Plain hyphens");
    // Auto-expanded, with the raw call tucked away.
    expect(screen.getByText("Raw call")).toBeTruthy();
  });

  it("marks an already-present style rule as unchanged", () => {
    renderOpen(call({
      name: "update_user_writing_style",
      args: { content: "Dup" },
      output: JSON.stringify({ ok: true, updated: false, message: "Already in the guide.", content: "Dup" }),
    }));
    expect(screen.getByText("Writing style · unchanged")).toBeTruthy();
  });

  it("lists from → to rows per task from the result's changes", () => {
    renderOpen(call({
      name: "update_tasks",
      args: { cardIds: ["a"], columnType: "review" },
      output: JSON.stringify({ id: "a", title: "Fix login", updated: true, changes: [{ id: "a", title: "Fix login", field: "column", from: "Todo", to: "Review" }] }),
    }));
    expect(screen.getAllByText("Fix login").length).toBeGreaterThan(1);
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
  });

  it("summarises idea-flow ops with correct plurals", () => {
    renderOpen(call({
      name: "edit_idea_flow",
      args: { ops: [{ op: "add_node", data: { label: "A" } }, { op: "add_node", data: { label: "B" } }, { op: "add_edge" }] },
      output: JSON.stringify({ results: [] }),
    }));
    expect(screen.getByText("2 nodes added · 1 connection added")).toBeTruthy();
  });

  it("falls back to the generic panels for a failed call", async () => {
    renderCall(call({ name: "update_tasks", ok: false, args: { cardIds: ["x"] }, error: "nope" }));
    await userEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Raw call")).toBeNull();
    expect(screen.getByText("Arguments")).toBeTruthy();
  });
});

describe("Cairn approval card", () => {
  it("previews the pending change instead of a JSON dump", () => {
    const { container } = render(<ConversationToolCall
      sessionId="s1"
      toolCall={call({ name: "edit_note", args: { noteId: "n1", oldString: "old line", newString: "new line" }, confirmRequired: true })}
    />, { wrapper: TooltipProvider });
    expect(screen.getByTestId("approval-cairn-view").textContent).toContain("old line");
    expect(screen.getByTestId("approval-cairn-view").textContent).toContain("new line");
    expect(screen.queryByTestId("approval-preview")).toBeNull();
    // The summary view leads; the raw arguments sit behind the disclosure, not in the old JSON preview.
    expect(container.querySelector("details[data-testid='approval-cairn-args']")).not.toBeNull();
  });

  it("shows an Arguments tree for a Cairn tool without a view", () => {
    render(<ConversationToolCall
      sessionId="s1"
      toolCall={call({ name: "spawn_tasks_from_note", args: { noteId: "n1" }, confirmRequired: true })}
    />, { wrapper: TooltipProvider });
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.queryByTestId("approval-preview")).toBeNull();
  });
});

describe("review fixes", () => {
  it("keeps the applied part of a failed bulk update visible", () => {
    renderCall(call({
      name: "update_tasks",
      ok: false,
      args: { cardIds: ["a", "b"], priority: "high" },
      error: JSON.stringify({ updated: [], changes: [{ id: "a", title: "Task A", field: "priority", from: "low", to: "high" }], error: "b: Task not found" }),
    }));
    // Failed calls stay collapsed; open it.
    return userEvent.click(screen.getByRole("button")).then(() => {
      expect(screen.getByText("b: Task not found")).toBeTruthy();
      expect(screen.getByText("Changes")).toBeTruthy();
      expect(screen.getAllByText("Task A").length).toBeGreaterThan(0);
    });
  });

  it("says a no-op update changed nothing instead of echoing the request", () => {
    renderOpen(call({ name: "update_tasks", args: { cardIds: ["a"], columnType: "review" }, output: JSON.stringify({ id: "a", title: "A", updated: true, changes: [] }) }));
    expect(screen.getByText(/No changes/)).toBeTruthy();
  });

  it("labels argument-derived rows 'Requested', not 'Changes'", () => {
    renderOpen(call({ name: "update_tasks", args: { cardIds: ["a"], title: "ship_api", columnType: "in_progress" }, output: JSON.stringify({ id: "a", updated: true }) }));
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.getByText("ship_api")).toBeTruthy(); // titles keep their underscores
    expect(screen.getByText("in progress")).toBeTruthy(); // enum labels do not
  });

  it("shows a single ready task returned as a top-level array", () => {
    renderCall(call({ name: "search_tasks", args: { filter: "ready" }, output: JSON.stringify([{ id: "k1", title: "Login bug" }]) }));
    return userEvent.click(screen.getByRole("button")).then(() => {
      expect(screen.getByText("Login bug")).toBeTruthy();
      expect(screen.queryByText(/No results/)).toBeNull();
    });
  });

  it("treats a whitespace-only oldString as a patch, not an append", () => {
    renderOpen(call({ name: "edit_note", args: { noteId: "n", oldString: "\n\n", newString: "\n--\n" }, output: JSON.stringify({ id: "n", title: "T" }) }));
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.queryByText("Appended")).toBeNull();
  });

  it("keeps a line of replacement visible when the removed text is long", () => {
    const removed = Array.from({ length: 12 }, (_, i) => `old ${i}`).join("\n");
    const { container } = renderOpen(call({ name: "edit_note", args: { noteId: "n", oldString: removed, newString: "the new line" }, output: JSON.stringify({ id: "n", title: "T" }) }));
    expect(container.textContent).toContain("the new line");
    expect(container.textContent).toContain("more lines");
  });

  it("does not report a note or move for a claim", () => {
    renderOpen(call({ name: "task_progress", args: { action: "claim", cardId: "a", agent: "Claude", message: "ignored", moveTo: "done" }, output: JSON.stringify({ ok: true }) }));
    expect(screen.queryByText("ignored")).toBeNull();
    expect(screen.queryByText("moved to")).toBeNull();
  });

  it("does not call a no-op style rule an addition", () => {
    renderCall(call({ name: "update_user_writing_style", args: { content: "Dup", section: "5" }, output: JSON.stringify({ ok: true, updated: false, content: "Dup", section: "5" }) }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toContain("Writing style already had this");
  });

  it("keeps a successful write collapsed, with a button that opens the note it touched", () => {
    renderCall(call({ name: "update_notes", args: { noteIds: ["n"], linkCardIds: ["k"] }, output: JSON.stringify({ id: "n", title: "T", updated: true }) }));
    expect(screen.getByTestId("cairn-tool-summary").closest("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("cairn-ref-open")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open note" })).toBeTruthy();
  });

  it("opening the item from the collapsed card does not expand it", () => {
    renderCall(call({ name: "create_task", args: { projectId: "p", title: "T" }, output: JSON.stringify({ id: "k1", title: "T" }) }));
    fireEvent.click(screen.getByTestId("cairn-ref-open"));
    expect(screen.getByTestId("cairn-tool-summary").closest("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers no open button for a failed or item-less call", () => {
    renderCall(call({ name: "create_task", ok: false, args: {}, output: JSON.stringify({ id: "k1", title: "T" }) }));
    expect(screen.queryByTestId("cairn-ref-open")).toBeNull();
  });

  it("masks secrets in the specialised view the same as the raw call", () => {
    const { container } = renderOpen(call({ name: "edit_note", args: { noteId: "n", token: "sk-live-abcdefghijklmnopqrstuvwxyz123456", newString: "x" }, output: JSON.stringify({ id: "n", title: "T" }) }));
    expect(container.textContent).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("renders [] for an empty result instead of a blank panel", async () => {
    renderCall(call({ name: "get_graph", args: {}, output: "[]" }));
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("[]")).toBeTruthy();
  });
});

describe("failed calls", () => {
  it("does not present a failed delete or edit as applied", () => {
    renderCall(call({ name: "delete", args: { type: "note", id: "n1" }, ok: false, output: JSON.stringify({ error: "Note not found" }) }));
    fireEvent.click(screen.getByRole("button", { name: /failed/ }));
    expect(document.body.textContent).not.toContain("was deleted");
    expect(document.body.textContent).toContain("Note not found");
  });
});

describe("approval fixes", () => {
  it("words a pending delete in the future tense", () => {
    render(<ConversationToolCall sessionId="s1" toolCall={call({ name: "delete", args: { type: "note", id: "n1" }, confirmRequired: true })} />, { wrapper: TooltipProvider });
    const view = screen.getByTestId("approval-cairn-view").textContent ?? "";
    expect(view).toContain("will delete");
    expect(view).not.toContain("was deleted");
    const title = screen.getByTestId("approval-title").textContent ?? "";
    expect(title).toMatch(/^Delete note/);
    expect(title).not.toContain("Deleted");
  });

  it("keeps the full arguments one click away beside the preview", () => {
    render(<ConversationToolCall sessionId="s1" toolCall={call({ name: "create_task", args: { projectId: "p", title: "T", description: "Details only in args" }, confirmRequired: true })} />, { wrapper: TooltipProvider });
    expect(screen.getByTestId("approval-cairn-args").textContent).toContain("Details only in args");
  });
});

describe("search headers", () => {
  it("says how many hits a finished search found", () => {
    renderCall(call({ name: "search_notes", args: { query: "login" }, output: JSON.stringify([{ id: "n1", title: "A" }, { id: "n2", title: "B" }]) }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toContain("Found 2 notes for “login”");
  });

  it("says when nothing matched, and a folder listing needs no query", () => {
    renderCall(call({ name: "search_notes", args: { query: "zzz" }, output: "[]" }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toContain("No notes matched “zzz”");
  });

  it("does not claim a count for a failed search", () => {
    renderCall(call({ name: "search_notes", ok: false, args: { query: "x" }, error: "boom" }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).not.toContain("Found");
  });
});


describe("People tool card", () => {
  it("renders the people tool as a Cairn card with a readable summary", () => {
    renderCall(call({ name: "people", args: { action: "get", name: "Ana Lopez" }, output: "{}" }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toBe("Cairn · Read Ana Lopez");
  });

  it("lists people from a query with their relationships", () => {
    renderOpen(call({
      name: "people",
      args: { action: "query", relationship: "direct_report" },
      output: JSON.stringify({ total: 2, people: [{ id: "p1", name: "Ana Lopez", relationship: ["direct_report"], cadence: "weekly" }, { id: "p2", name: "Ben Okafor", relationship: ["direct_report"], status: "suggested" }] }),
    }));
    expect(screen.getByText("2 people")).toBeTruthy();
    expect(screen.getByText("Ana Lopez")).toBeTruthy();
    expect(screen.getAllByText("direct report").length).toBe(2);
    expect(screen.getByText("suggested")).toBeTruthy();
  });

  it("keeps underscores in a custom relationship label", () => {
    renderOpen(call({
      name: "people",
      args: { action: "query" },
      output: JSON.stringify({ total: 1, people: [{ id: "p1", name: "Ana Lopez", relationship: ["direct_report (Data_Platform)"] }] }),
    }));
    expect(screen.getByText("direct report (Data_Platform)")).toBeTruthy();
  });

  it("summarises a name-only save from the result and an unremoved attendee", () => {
    renderCall(call({ name: "people", args: { action: "upsert", name: "Ana Lopez" }, output: JSON.stringify({ created: false, updated: true, person: { id: "p1", name: "Ana Lopez" } }) }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toBe("Cairn · Updated Ana Lopez");
  });

  it("shows a person's details and offers to open them", () => {
    renderOpen(call({
      name: "people",
      args: { action: "get", personId: "p1" },
      output: JSON.stringify({ id: "p1", name: "Ana Lopez", relationship: ["direct_report"], cadence: "weekly", relations: [{ role: "manager", name: "Alex Morgan" }] }),
    }));
    expect(screen.getAllByText("Ana Lopez").length).toBeGreaterThan(0);
    expect(screen.getByText("Alex Morgan")).toBeTruthy();
    expect(screen.getByTestId("people-open")).toBeTruthy();
  });

  it("describes a link between two people in words", () => {
    renderOpen(call({
      name: "people",
      args: { action: "link", link: "edge", personId: "p1", edgeType: "manager_of", otherPersonId: "p2" },
      output: JSON.stringify({ linked: true, edge: { id: "e1", source: "Alex Morgan", type: "manager_of", target: "Ana Lopez", status: "confirmed" } }),
    }));
    expect(screen.getByText("Linked")).toBeTruthy();
    expect(screen.getAllByText(/manages/).length).toBeGreaterThan(0);
  });

  it("stays open when the transcript remounts the card mid-turn", async () => {
    const tc = call({ name: "people", callId: "remount-1", args: { action: "inventory" }, output: "{}" });
    const first = renderCall(tc);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    first.unmount();
    renderCall(tc);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });
});
