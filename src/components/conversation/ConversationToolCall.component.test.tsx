import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConversationToolCall } from "./ConversationToolCall";
import type { ConversationToolCall as ToolCall } from "@/lib/conversation/message";
import type { ConnectorMeta } from "@/components/shared/ConnectorToolCard";

/**
 * Connector (MCP / HTTP service) tool calls in the transcript: the approval
 * card names the connector and the action instead of "Used" + a bare "{}",
 * and a settled `skill` call uses the standard chip like every other tool.
 */

const connectors: Record<string, ConnectorMeta> = {
  "mcp__atl1__": { name: "atlassian", kind: "mcp", label: "Confluence", brandColor: "#1868DB" },
};

function call(over: Partial<ToolCall>): ToolCall {
  return { name: "tool", label: "tool", ok: true, callId: "c1", ...over };
}

describe("connector approval card", () => {
  it("shows the connector, the action and its arguments", () => {
    render(<ConversationToolCall
      sessionId="s1"
      connectors={connectors}
      toolCall={call({ name: "mcp__atl1__createConfluencePage", args: { spaceId: "42", title: "Q3 plan" }, confirmRequired: true })}
    />);
    expect(screen.getByTestId("approval-connector").textContent).toBe("Confluence via MCP");
    // The connector's own name is dropped from the action ("Create confluence page").
    expect(screen.getByTestId("approval-title").textContent).toBe("Create page Q3 plan");
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.queryByTestId("approval-preview")).toBeNull();
  });

  it("says 'No arguments' instead of rendering {}", () => {
    const { container } = render(<ConversationToolCall
      sessionId="s1"
      connectors={connectors}
      toolCall={call({ name: "mcp__atl1__getAccessibleAtlassianResources", args: {}, confirmRequired: true })}
    />);
    expect(screen.getByTestId("approval-no-args")).toBeTruthy();
    expect(container.textContent).not.toContain("{}");
  });

  it("drops the {} preview for an argument-less call from an unknown connector", () => {
    const { container } = render(<ConversationToolCall
      sessionId="s1"
      toolCall={call({ name: "mcp__zzz__ping", args: {}, confirmRequired: true })}
    />);
    expect(screen.getByTestId("approval-title").textContent).toBe("Ping");
    expect(container.textContent).not.toContain("{}");
  });
});

describe("skill chip", () => {
  it("renders a settled skill call as the standard tool chip", () => {
    const { container } = render(<ConversationToolCall
      toolCall={call({ name: "skill", args: { name: "pdf" }, output: "# PDF skill" })}
    />);
    expect(container.textContent).toContain("Loaded skill pdf");
    expect(container.querySelector("[data-tool='skill']")).toBeNull();
  });
});

describe("opened tool cards survive a remount", () => {
  // The transcript is virtualised and rebuilds rows mid-turn, so a card can unmount and mount again.
  it("keeps a connector card open", () => {
    const tc = call({ callId: "remount-connector", name: "mcp__atl1__getPage", args: { id: "1" }, output: "{\"title\":\"Q3\"}" });
    const first = render(<TooltipProvider><ConversationToolCall sessionId="s1" connectors={connectors} toolCall={tc} /></TooltipProvider>);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    first.unmount();
    render(<TooltipProvider><ConversationToolCall sessionId="s1" connectors={connectors} toolCall={tc} /></TooltipProvider>);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a generic tool chip open, and closes it when the user closes it", () => {
    const tc = call({ callId: "remount-generic", name: "bash", args: { command: "ls" }, output: "a.txt" });
    const first = render(<ConversationToolCall sessionId="s1" toolCall={tc} />);
    expect(screen.queryByText("a.txt")).toBeNull();
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByText("a.txt")).toBeTruthy();
    first.unmount();
    const second = render(<ConversationToolCall sessionId="s1" toolCall={tc} />);
    expect(screen.getByText("a.txt")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button")[0]);
    second.unmount();
    render(<ConversationToolCall sessionId="s1" toolCall={tc} />);
    expect(screen.queryByText("a.txt")).toBeNull();
  });

  it("starts collapsed for a call nobody has opened", () => {
    render(<ConversationToolCall sessionId="s1" toolCall={call({ callId: "never-opened", name: "bash", args: { command: "ls" }, output: "b.txt" })} />);
    expect(screen.queryByText("b.txt")).toBeNull();
  });
});
