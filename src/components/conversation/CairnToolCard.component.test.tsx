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
    renderCall(call({ name: "update_user_writing_style", args: { section: "5", content: "Plain hyphens" }, output: "{}" }));
    expect(screen.getByTestId("cairn-tool-summary").textContent).toBe("Cairn · Added to writing style 5");
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
