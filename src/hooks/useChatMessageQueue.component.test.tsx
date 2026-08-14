import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { useChatMessageQueue, useQueueDrain, type QueuedMessage } from "./useChatMessageQueue";

interface SentRequest {
  /** Message-history snapshot baked into the request (like formatChatHistory). */
  history: string[];
  message: string;
}

/**
 * Faithful miniature of the chat-panel queue wiring.
 *
 * `send` snapshots the CURRENT `messages` into the request history — exactly
 * like formatChatHistory(messages) inside the chat panel's handleSend. `submit`
 * enqueues while a turn runs and sends immediately otherwise. `completeTurn`
 * finishes a turn the way chat:done does: it appends the assistant reply and
 * flips loading off in the SAME update, then the queue drains.
 */
function QueueHarness({ onRequest, hasThread = false }: { onRequest: (r: SentRequest) => void; hasThread?: boolean }) {
  const [messages, setMessages] = useState<Array<{ role: string; text: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const queue = useChatMessageQueue<QueuedMessage>();

  const send = useCallback((text: string) => {
    onRequest({ history: messages.map((m) => `${m.role}:${m.text}`), message: text });
    setMessages((prev) => [...prev, { role: "user", text }]);
    setIsLoading(true);
  }, [messages, onRequest]);

  useQueueDrain(isLoading, queue.drainNext, (next) => {
    // Mirrors the chat panel's thread guard: only send into the active thread.
    if (!hasThread || next.threadId === "active") send(next.content);
  });

  const submit = useCallback((text: string, threadId?: string) => {
    if (isLoading) {
      queue.enqueue({ id: text, content: text, ...(threadId ? { threadId } : {}) });
    } else {
      send(text);
    }
  }, [isLoading, queue, send]);

  const activeThreadId = hasThread ? "active" : undefined;
  return (
    <div>
      <button onClick={() => submit("A", activeThreadId)}>submit A</button>
      <button onClick={() => submit("B", activeThreadId)}>submit B</button>
      <button onClick={() => submit("C", activeThreadId)}>submit C</button>
      <button onClick={() => submit("stale", "old-thread")}>submit stale thread</button>
      <button onClick={() => { setMessages((p) => [...p, { role: "assistant", text: "reply" }]); setIsLoading(false); }}>
        complete turn
      </button>
      <button onClick={() => { setMessages((p) => [...p, { role: "assistant", text: "reply 2" }]); setIsLoading(false); }}>
        complete turn 2
      </button>
      <button onClick={() => queue.removeQueued("B")}>remove B</button>
      <button onClick={() => queue.clearQueue()}>clear queue</button>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="queued">{queue.queued.length}</span>
    </div>
  );
}

function setup(hasThread = false) {
  const requests: SentRequest[] = [];
  render(<QueueHarness onRequest={(r) => requests.push(r)} hasThread={hasThread} />);
  return {
    requests,
    submitA: () => userEvent.click(screen.getByText("submit A")),
    submitB: () => userEvent.click(screen.getByText("submit B")),
    submitC: () => userEvent.click(screen.getByText("submit C")),
    submitStale: () => userEvent.click(screen.getByText("submit stale thread")),
    complete: () => userEvent.click(screen.getByText("complete turn")),
    complete2: () => userEvent.click(screen.getByText("complete turn 2")),
    removeB: () => userEvent.click(screen.getByText("remove B")),
    clear: () => userEvent.click(screen.getByText("clear queue")),
    queuedCount: () => Number(screen.getByTestId("queued").textContent),
  };
}

describe("message queue", () => {
  it("sends immediately when idle and queues (never sends) while a turn is running", async () => {
    const h = setup();
    await h.submitA();
    expect(h.requests).toEqual([{ history: [], message: "A" }]);
    expect(h.queuedCount()).toBe(0);

    // Turn A is running — B is queued, not sent.
    await h.submitB();
    expect(h.requests).toHaveLength(1);
    expect(h.queuedCount()).toBe(1);
  });

  it("drains queued messages FIFO, one per turn, in order", async () => {
    const h = setup();
    await h.submitA();            // turn A running
    await h.submitB();            // queued [B]
    await h.submitC();            // queued [B, C]
    expect(h.queuedCount()).toBe(2);

    await h.complete();           // turn A finishes → drains B
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].message).toBe("B");
    expect(h.queuedCount()).toBe(1);

    await h.complete2();          // turn B finishes → drains C
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].message).toBe("C");
    expect(h.queuedCount()).toBe(0);

    // The drained C turn includes the full history up to that point.
    expect(h.requests[2].history).toEqual([
      "user:A", "assistant:reply", "user:B", "assistant:reply 2",
    ]);
  });

  it("regression: a drained message is sent with the FRESH history including the reply that just finished, not a stale pre-reply snapshot", async () => {
    const h = setup();
    await h.submitA();            // turn A running: messages = [user:A]
    await h.submitB();            // queued
    await h.complete();           // turn A finishes (appends assistant reply + loading off)

    // The queued B must be sent with the completed turn in its history —
    // [user:A, assistant:reply] — otherwise the model sees the last user
    // message A re-delivered back-to-back with the queued B.
    expect(h.requests[1]).toEqual({
      history: ["user:A", "assistant:reply"],
      message: "B",
    });
  });

  it("regression: multiple queued messages each see the growing history", async () => {
    const h = setup();
    await h.submitA();
    await h.submitB();
    await h.submitC();
    await h.complete();   // drains B
    await h.complete2();  // drains C

    // B sees the finished turn A; C sees finished turns A and B.
    expect(h.requests[1].history).toEqual(["user:A", "assistant:reply"]);
    expect(h.requests[2].history).toEqual([
      "user:A", "assistant:reply", "user:B", "assistant:reply 2",
    ]);
  });

  it("drops a queued item when removed, and never sends it", async () => {
    const h = setup();
    await h.submitA();
    await h.submitB();
    await h.submitC();
    expect(h.queuedCount()).toBe(2);

    await h.removeB();            // remove queued B
    expect(h.queuedCount()).toBe(1);

    await h.complete();           // drains C (B was removed)
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].message).toBe("C");
    expect(h.queuedCount()).toBe(0);
  });

  it("clears the whole queue (thread switch) without sending anything", async () => {
    const h = setup();
    await h.submitA();
    await h.submitB();
    await h.submitC();
    expect(h.queuedCount()).toBe(2);

    await h.clear();              // thread switch drops pending messages
    expect(h.queuedCount()).toBe(0);

    await h.complete();           // turn finishes, but nothing is queued
    expect(h.requests).toHaveLength(1);
  });

  it("consumes a drained item queued for a different thread but does not send it", async () => {
    const h = setup(true);        // thread guard enabled (active thread = "active")
    await h.submitA();            // turn A running
    await h.submitStale();        // queued for a thread the user left
    expect(h.queuedCount()).toBe(1);

    await h.complete();           // drain fires but the item's thread is stale
    expect(h.queuedCount()).toBe(0); // item consumed
    expect(h.requests).toHaveLength(1); // not delivered anywhere
  });
});
