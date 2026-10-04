import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
