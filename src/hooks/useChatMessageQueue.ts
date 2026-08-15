"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Shared FIFO queue for messages/prompts the user sends while a turn is
 * running. The queue drains (one item per turn-end) when the current reply
 * finishes, is kept on Stop, drains after errors too, and is cleared on
 * thread/session switch.
 *
 * Used by the chat panel (src/components/chat/chat-panel) and the coding-agent
 * pane (src/components/agent/AgentChatPane).
 */

export interface QueuedAttachment {
  kind: "image" | "pdf";
  name: string;
  dataUrl: string;
}

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: QueuedAttachment[];
  /** Chat panel: the thread the message was queued for — the drain only sends
   *  into that thread so a thread switch can't post it into the wrong one. */
  threadId?: string;
}

export function useChatMessageQueue<T extends QueuedMessage = QueuedMessage>() {
  const [queued, setQueued] = useState<T[]>([]);
  // Read from a ref inside the drain so the drain effect never needs `queued`
  // as a dependency (it would otherwise re-fire on every enqueue/remove).
  const queuedRef = useRef<T[]>([]);
  useEffect(() => { queuedRef.current = queued; }, [queued]);
  // Collapsed pinned queue: shows just the count by default; expands on click
  // to list (truncated) messages with remove buttons.
  const [queueExpanded, setQueueExpanded] = useState(false);

  const enqueue = useCallback((msg: T) => {
    setQueued((prev) => [...prev, msg]);
  }, []);

  const removeQueued = useCallback((qid: string) => {
    setQueued((prev) => prev.filter((q) => q.id !== qid));
  }, []);

  const clearQueue = useCallback(() => {
    setQueued([]);
  }, []);

  /** Pops the head of the queue (FIFO) and returns it, or null when empty. The
   *  item is consumed unconditionally — the caller decides whether to actually
   *  send it (e.g. drop it when it belongs to a now-inactive thread). */
  const drainNext = useCallback((): T | null => {
    const next = queuedRef.current[0] ?? null;
    if (next) setQueued((prev) => prev.slice(1));
    return next;
  }, []);

  return { queued, queueExpanded, setQueueExpanded, enqueue, removeQueued, clearQueue, drainNext };
}

/**
 * Drains the queue when a turn finishes: when `isLoading` goes true → false,
 * pops the next queued item via `drainNext` and hands it to `onDrain`.
 *
 * The sink (`onDrain`) is kept in a ref refreshed via `useLayoutEffect`, so the
 * drain ALWAYS invokes the LATEST sink — one closing over the freshest message
 * history and thread. A passive-effect refresh (plain `useEffect` declared
 * after this hook) would leave the drain holding a STALE closure from the
 * pre-reply render: the drained message would be sent with a history that ends
 * at the previous user turn, so the next request re-delivers "the last message
 * and the queued message" as two back-to-back user turns (see the regression
 * test in useChatMessageQueue.component.test.tsx).
 */
export function useQueueDrain<T>(
  isLoading: boolean,
  drainNext: () => T | null,
  onDrain: (next: T) => void,
): void {
  const onDrainRef = useRef(onDrain);
  useLayoutEffect(() => { onDrainRef.current = onDrain; }, [onDrain]);

  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;
    if (wasLoading && !isLoading) {
      const next = drainNext();
      if (next !== null) onDrainRef.current(next);
    }
  }, [isLoading, drainNext]);
}
