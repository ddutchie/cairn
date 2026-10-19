import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConversationToolCall } from "@/components/conversation/ConversationToolCall";
import { A2uiActionProvider, formatA2uiAction } from "./a2ui-action-context";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";

const messages = [
  { version: "v0.9", createSurface: { surfaceId: "s", catalogId: basicCatalog.id } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "s",
      components: [
        { id: "root", component: "Column", children: ["t"] },
        { id: "t", component: "Text", text: "Pick one" },
      ],
    },
  },
];

describe("render_ui tool call", () => {
  it("renders an A2UI surface in the transcript instead of a tool chip", async () => {
    render(
      <A2uiActionProvider value={vi.fn()}>
        <ConversationToolCall toolCall={{ name: "render_ui", label: "Showing UI", ok: true, callId: "c1", args: { title: "Choose", messages } }} />
      </A2uiActionProvider>,
    );
    expect(await screen.findByTestId("a2ui-surface")).toBeTruthy();
    expect(screen.getByText("Choose")).toBeTruthy();
  });

  it("falls back to the plain chip when the call has no messages", () => {
    render(<ConversationToolCall toolCall={{ name: "render_ui", label: "Showing UI", ok: true, callId: "c2", args: {} }} />);
    expect(screen.queryByTestId("a2ui-surface")).toBeNull();
  });
});

describe("formatA2uiAction", () => {
  it("is a one-line model-readable message", () => {
    expect(formatA2uiAction({ name: "create_card", context: { title: "x" } })).toBe('[UI action] create_card {"title":"x"}');
    expect(formatA2uiAction({ name: "ok", context: {} })).toBe("[UI action] ok");
  });
});
