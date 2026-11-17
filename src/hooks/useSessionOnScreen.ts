"use client";

import { useEffect, type RefObject } from "react";
import { sessionClient } from "@/lib/ipc/session";

/**
 * Report `sessionId` to the main process while the element in `ref` is visible.
 *
 * Approval notices skip a session some window is showing, so an approval in a
 * chat behind another tab, a collapsed panel or a closed dialog still reaches
 * the notification bell. Visibility comes from an IntersectionObserver, which
 * also sees panes that stay mounted but CSS-hidden (`hidden`, `display: none`).
 */
export function useSessionOnScreen(sessionId: string | null | undefined, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!sessionId || !el || typeof IntersectionObserver === "undefined") return;
    let shown = false;
    const set = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      void sessionClient.setOnScreen(sessionId, on).catch(() => undefined);
    };
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) set(entry.isIntersecting);
    });
    observer.observe(el);
    return () => { observer.disconnect(); set(false); };
  }, [sessionId, ref]);
}
