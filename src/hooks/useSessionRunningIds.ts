"use client";

import { useEffect, useState } from "react";

// Shared coalesced poller for `session:running-ids`.
// Sidebar mounts one SessionBrowser per expanded project (sidebar.tsx:605),
// each would otherwise setInterval(2000) → N× IPC. This singleton fans out
// a single interval to all subscribers and pauses when the page is hidden.
let sharedIds: Set<string> = new Set();
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let visibilityAttached = false;
let pausedByVisibility = false;

const listeners = new Set<(ids: Set<string>) => void>();

function poll() {
  if (!window.electron?.session?.runningIds) return;
  window.electron.session
    .runningIds()
    .then((result) => {
      sharedIds = new Set(result.ids);
      for (const fn of listeners) fn(sharedIds);
    })
    .catch(() => undefined);
}

function startTimer() {
  if (timer !== null) return;
  poll();
  timer = setInterval(poll, 2000);
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function handleVisibility() {
  if (document.hidden) {
    if (timer !== null) {
      stopTimer();
      pausedByVisibility = true;
    }
  } else if (pausedByVisibility && subscribers > 0) {
    pausedByVisibility = false;
    startTimer();
  }
}

function ensureVisibilityListener() {
  if (visibilityAttached || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibility);
  visibilityAttached = true;
}

/**
 * Subscribe to the coalesced running-ids set.
 * `active` controls whether this caller counts toward the shared interval.
 * When no callers are active the interval is torn down.
 * The hook returns the current set (empty until first poll).
 */
export function useSessionRunningIds(active: boolean): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => sharedIds);

  useEffect(() => {
    if (!active) return;
    // Register
    subscribers += 1;
    listeners.add(setIds);
    // Push current shared value immediately so late subscribers don't wait 2s.
    setIds(new Set(sharedIds));
    ensureVisibilityListener();
    if (!document.hidden) startTimer();

    return () => {
      subscribers -= 1;
      listeners.delete(setIds);
      if (subscribers === 0) {
        stopTimer();
        pausedByVisibility = false;
      }
    };
  }, [active]);

  // Keep local state in sync if sharedIds updates while inactive? Not needed,
  // but if component toggles active off then on, it will resync via the
  // immediate setIds above.
  return ids;
}
