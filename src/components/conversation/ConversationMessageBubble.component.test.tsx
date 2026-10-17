import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConversationMessageBubble } from "./ConversationMessageBubble";
import type { ConversationMessage } from "@/lib/conversation/message";
import { createLiveStreamStore } from "@/lib/conversation/live-stream-store";

const renderBubble = (message: ConversationMessage) =>
  render(<TooltipProvider><ConversationMessageBubble message={message} sessionId="s1" /></TooltipProvider>);

const base: ConversationMessage = {
  id: "m1",
  role: "assistant",
  content: "Hello there",
  createdAt: "2026-10-14T00:00:00Z",
  stats: { ttftMs: 800, tokensPerSecond: 40, outputTokens: 500 },
};

describe("ConversationMessageBubble actions row", () => {
  it("puts Copy, Report and stats in one row and expands stats inline", async () => {
    const user = userEvent.setup();
    renderBubble(base);
    const copy = screen.getByRole("button", { name: "Copy" });
    const report = screen.getByRole("button", { name: /report an issue/i });
    const stats = screen.getByRole("button", { name: "Message speed & token stats" });
    expect(copy.parentElement).toBe(report.parentElement);
    expect(copy.parentElement).toBe(stats.parentElement);

    // Native title attributes are replaced by the app tooltip.
    expect(copy).not.toHaveAttribute("title");
    expect(screen.queryByText("800ms to first token")).toBeNull();
    await user.click(stats);
    expect(screen.getByText("800ms to first token")).toBeInTheDocument();
    expect(screen.getByText("40.0 tok/s")).toBeInTheDocument();
  });

  it("omits the stats button when there are no stats", () => {
    renderBubble({ ...base, stats: undefined });
    expect(screen.queryByRole("button", { name: "Message speed & token stats" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("shows no report or stats controls on a user message", () => {
    renderBubble({ ...base, role: "user" });
    expect(screen.queryByRole("button", { name: /report an issue/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Message speed & token stats" })).toBeNull();
  });
});

describe("ConversationMessageBubble live turn", () => {
  it("renders streamed text from the store without the parent re-rendering", () => {
    const store = createLiveStreamStore();
    const live: ConversationMessage = { id: "stream-s1", role: "assistant", content: "", isStreaming: true, liveStream: store, createdAt: base.createdAt };
    renderBubble(live);
    expect(screen.queryByText("Streaming reply")).toBeNull();
    act(() => store.set("Streaming reply", ""));
    expect(screen.getByText("Streaming reply")).toBeInTheDocument();
    act(() => store.set("Streaming reply, more", "thinking"));
    expect(screen.getByText("Streaming reply, more")).toBeInTheDocument();
  });
});
