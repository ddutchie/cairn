"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * FIFO queues for messages/prompts the user sends while a turn is running, one
 * per thread/session. A queue drains (one item per turn-end) when that
 * thread's reply finishes, is kept on Stop, drains after errors too, and
 * survives switching to another thread.
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

// One queue per thread/session, held outside React: it survives switching
// threads and the panel remounting, and a thread's queue can be drained while
// another thread is on screen.
const queues = new Map<string, QueuedMessage[]>();
const listeners = new Set<() => void>();
const EMPTY: QueuedMessage[] = [];

function writeQueue(key: string, next: QueuedMessage[]): void {
  if (next.length === 0) queues.delete(key); else queues.set(key, next);
  for (const fn of listeners) fn();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** What is queued for a thread right now (not reactive; for event handlers). */
export function queuedFor(key: string): QueuedMessage[] {
  return queues.get(key) ?? EMPTY;
}

/** Test hook: drop every queue. */
export function _resetChatMessageQueues(): void {
  queues.clear();
  for (const fn of listeners) fn();
}

/**
 * Resolves true once the main process reports the session is not running, or
 * false if it is still running after `timeoutMs`. A queued message must not be
 * sent before then: the main process rejects a prompt for a session whose turn
 * is still winding down (for example right after Stop).
 */
export async function waitForSessionIdle(sessionId: string, timeoutMs = 5_000): Promise<boolean> {
  const isRunning = typeof window === "undefined" ? undefined : window.electron?.session?.isRunning;
  if (!isRunning) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let running = false;
    try { running = (await isRunning(sessionId))?.running ?? false; } catch { return true; }
    if (!running) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * The queue of one thread/session (`key`). Without a key the queue is private
 * to this hook instance. `enqueue`, `clearQueue` and `drainNext` take an
 * optional key to act on another thread's queue.
 */
export function useChatMessageQueue<T extends QueuedMessage = QueuedMessage>(key?: string | null) {
  const ownKey = useId();
  const activeKey = key ?? `\0local:${ownKey}`;
  const activeKeyRef = useRef(activeKey);
  useLayoutEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);
  // A private queue dies with its owner.
  useEffect(() => () => { queues.delete(`\0local:${ownKey}`); }, [ownKey]);

  const queued = useSyncExternalStore(
    subscribe,
    () => queues.get(activeKey) ?? EMPTY,
    () => EMPTY,
  ) as T[];
  // Collapsed pinned queue: shows just the count by default; expands on click
  // to list (truncated) messages with remove buttons.
  const [queueExpanded, setQueueExpanded] = useState(false);

  /** `front` puts the message at the head (it is sent next). */
  const enqueue = useCallback((msg: T, forKey?: string, front = false) => {
    const k = forKey ?? activeKeyRef.current;
    const current = queues.get(k) ?? EMPTY;
    writeQueue(k, front ? [msg, ...current] : [...current, msg]);
  }, []);

  const removeQueued = useCallback((qid: string) => {
    const k = activeKeyRef.current;
    writeQueue(k, (queues.get(k) ?? EMPTY).filter((q) => q.id !== qid));
  }, []);

  /** Move a queued message to the head so it is the next one sent. */
  const promoteQueued = useCallback((qid: string) => {
    const k = activeKeyRef.current;
    const current = queues.get(k) ?? EMPTY;
    const item = current.find((q) => q.id === qid);
    if (item) writeQueue(k, [item, ...current.filter((q) => q.id !== qid)]);
  }, []);

  const clearQueue = useCallback((forKey?: string) => {
    writeQueue(forKey ?? activeKeyRef.current, []);
  }, []);

  /** Pops the head of the queue (FIFO) and returns it, or null when empty. */
  const drainNext = useCallback((forKey?: string): T | null => {
    const k = forKey ?? activeKeyRef.current;
    const current = queues.get(k) ?? EMPTY;
    const next = (current[0] ?? null) as T | null;
    if (next) writeQueue(k, current.slice(1));
    return next;
  }, []);

  return { queued, queueExpanded, setQueueExpanded, enqueue, removeQueued, promoteQueued, clearQueue, drainNext };
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
  /** The thread/session `isLoading` describes. A change of scope is not a turn ending. */
  scope?: string | null,
): void {
  const onDrainRef = useRef(onDrain);
  useLayoutEffect(() => { onDrainRef.current = onDrain; }, [onDrain]);

  const prevLoadingRef = useRef(isLoading);
  const prevScopeRef = useRef(scope);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    const sameScope = prevScopeRef.current === scope;
    prevLoadingRef.current = isLoading;
    prevScopeRef.current = scope;
    if (sameScope && wasLoading && !isLoading) {
      const next = drainNext();
      if (next !== null) onDrainRef.current(next);
    }
  }, [isLoading, drainNext, scope]);
}
