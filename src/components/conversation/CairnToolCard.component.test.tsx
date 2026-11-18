import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConversationToolCall } from "./ConversationToolCall";
import type { ConversationToolCall as ToolCall } from "@/lib/conversation/message";

function call(over: Partial<ToolCall>): ToolCall {
  return { name: "tool", label: "tool", ok: true, callId: "c1", ...over };
}

function renderCall(toolCall: ToolCall) {
  return render(<ConversationToolCall toolCall={toolCall} />, { wrapper: TooltipProvider });
}

describe("Cairn tool card", () => {
  it("renders a Cairn data tool as a collapsed 'Cairn · action' card", () => {
    renderCall(call({ name: "get_today", args: { date: "2026-11-18" }, output: "{}" }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toBe("Cairn · Read the Today brief for 2026-11-18");
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Arguments")).toBeNull();
  });

  it("expands to labelled Arguments and Result panels", async () => {
    renderCall(call({ name: "update_tasks", args: { cardIds: ["a"] }, output: JSON.stringify({ ok: true, updated: 1 }) }));
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
  });

  it("shows the error text for a failed call", async () => {
    renderCall(call({ name: "update_tasks", ok: false, args: { cardIds: ["x"] }, error: "Card not found" }));
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Card not found")).toBeTruthy();
  });

  it("leaves non-Cairn tools on the standard chip", () => {
    renderCall(call({ name: "bash", args: { command: "ls" }, output: "x" }));
    expect(screen.queryByTestId("cairn-tool-card")).toBeNull();
  });
});

describe("Cairn tool views", () => {
  it("shows a writing-style addition as a + line instead of the raw JSON", () => {
    const { container } = renderCall(call({
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
    renderCall(call({
      name: "update_user_writing_style",
      args: { content: "Dup" },
      output: JSON.stringify({ ok: true, updated: false, message: "Already in the guide.", content: "Dup" }),
    }));
    expect(screen.getByText("Writing style · unchanged")).toBeTruthy();
  });

  it("lists from → to rows per task from the result's changes", () => {
    renderCall(call({
      name: "update_tasks",
      args: { cardIds: ["a"], columnType: "review" },
      output: JSON.stringify({ id: "a", title: "Fix login", updated: true, changes: [{ id: "a", title: "Fix login", field: "column", from: "Todo", to: "Review" }] }),
    }));
    expect(screen.getAllByText("Fix login").length).toBeGreaterThan(1);
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
  });

  it("summarises idea-flow ops with correct plurals", () => {
    renderCall(call({
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
    expect(container.textContent).not.toContain('"oldString"');
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
