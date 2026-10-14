import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCairnStore } from "@/store";
import { ReportIssueControl } from "./ReportIssueControl";
import type { ConversationMessage } from "@/lib/conversation/message";

const message: ConversationMessage = {
  id: "m1",
  role: "assistant",
  content: "Here is my SECRET answer",
  createdAt: "2026-10-14T00:00:00Z",
  stats: { ttftMs: 800, tokensPerSecond: 40, outputTokens: 500 },
  toolCalls: [
    { name: "bash", label: "bash", ok: false },
    { name: "read", label: "read", ok: true },
  ],
};

const openExternal = vi.fn();

function lastBody(): string {
  const url = new URL(openExternal.mock.calls.at(-1)![0] as string);
  return url.searchParams.get("body") ?? "";
}

describe("ReportIssueControl", () => {
  beforeEach(() => {
    openExternal.mockReset();
    (window as unknown as { electron: unknown }).electron = { openExternal, runtime: {}, getWorkspacePath: () => Promise.resolve(null) };
    useCairnStore.setState({ activeView: "chat" } as never);
  });

  it("opens a prefilled GitHub issue with environment and stats but not the reply by default", async () => {
    const user = userEvent.setup();
    render(<ReportIssueControl message={message} />);
    await user.click(screen.getByRole("button", { name: /report an issue/i }));
    await user.type(screen.getByLabelText("What went wrong"), "It looped");
    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));

    expect(openExternal).toHaveBeenCalledOnce();
    expect(String(openExternal.mock.calls[0][0])).toContain("github.com/ddutchie/cairn/issues/new");
    const body = lastBody();
    expect(body).toContain("It looped");
    expect(body).toContain("- Surface: Chat");
    expect(body).toContain("- This turn: first token 800 ms, 40.0 tok/s, 500 output tokens");
    expect(body).toContain("- Tool calls: 2, 1 failed (bash)");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("MCP servers");
  });

  it("includes the reply and labels the coding agent surface when opted in", async () => {
    useCairnStore.setState({ activeView: "agent" } as never);
    const user = userEvent.setup();
    render(<ReportIssueControl message={message} />);
    await user.click(screen.getByRole("button", { name: /report an issue/i }));
    await user.click(screen.getByRole("switch", { name: "Include this reply" }));
    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));

    const body = lastBody();
    expect(body).toContain("- Surface: Coding agent");
    expect(body).toContain("Here is my SECRET answer");
  });
});
