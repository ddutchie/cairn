import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectorToolCard, type ConnectorMeta, type ConnectorToolCall } from "./ConnectorToolCard";

/**
 * Behaviour suite for the connector tool card (connector-inbound,
 * connector-id-reveal). Pure-props, no live OAuth / external service — the
 * connector metadata and tool call are supplied directly.
 */

const connector: ConnectorMeta = {
  name: "linear-mcp",
  kind: "mcp",
  brandColor: "#5E6AD2",
  label: "Linear",
};

function renderCard(toolCall: ConnectorToolCall, meta: ConnectorMeta = connector) {
  render(<ConnectorToolCard toolCall={toolCall} connector={meta} />);
}

describe("connector-inbound", () => {
  it("shows the branded connector label and transport, collapsed by default", () => {
    renderCard({ tool: "search_issues", args: { query: "sync" } });
    const card = screen.getByTestId("connector-message-card");
    expect(card).toBeTruthy();
    // Branded display label, not the raw internal name.
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.getByText("via MCP")).toBeTruthy();
    // Collapsed: details (arguments/result) are not in the DOM yet.
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Arguments")).toBeNull();
  });

  it("labels an HTTP service connector as such", () => {
    renderCard(
      { tool: "send_message" },
      { name: "slack-svc", kind: "service", label: "Slack" },
    );
    expect(screen.getByText("via HTTP service")).toBeTruthy();
  });

  it("expands to reveal the tool details on click", async () => {
    const user = userEvent.setup();
    renderCard({ tool: "search_issues", args: { query: "sync" }, output: '{"count":3}' });

    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
  });

  it("falls back to the raw name when no branded label is given", () => {
    renderCard({ tool: "search_issues" }, { name: "acme-mcp", kind: "mcp" });
    expect(screen.getByText("acme-mcp")).toBeTruthy();
  });
});

describe("connector-id-reveal", () => {
  it("redacts secret-like arguments when the details are revealed", async () => {
    const user = userEvent.setup();
    renderCard({
      tool: "create_issue",
      args: { title: "Bug", apiKey: "sk-live-SUPERSECRET123", token: "ghp_abcdef" },
    });

    await user.click(screen.getByRole("button"));
    const details = screen.getByTestId("connector-message-card").textContent ?? "";
    // The visible title survives…
    expect(details).toContain("Bug");
    // …but the secret values must never be rendered.
    expect(details).not.toContain("sk-live-SUPERSECRET123");
    expect(details).not.toContain("ghp_abcdef");
  });
});
