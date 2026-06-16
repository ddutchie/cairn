"use client";

import React, { useRef, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { MIN_CHAT_PANEL_WIDTH, MAX_CHAT_PANEL_WIDTH } from "@/store/slices/ui";
import { SessionPane } from "@/components/agent/SessionPane";

interface RightPanelProps {
  prefill?: { text: string; autoSend?: boolean } | null;
  onPrefillConsumed?: () => void;
}

export function RightPanel({ prefill, onPrefillConsumed }: RightPanelProps) {
  const { chatPanelWidth, setChatPanelWidth } = useCairnStore(useShallow((s) => ({
    chatPanelWidth: s.chatPanelWidth,
    setChatPanelWidth: s.setChatPanelWidth,
  })));

  const panelRef = useRef<HTMLElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const divider = dividerRef.current;
    const panel = panelRef.current;
    if (!divider || !panel) return;

    let dragging = false;
    let startX = 0;
    let startW = 0;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      // Panel is on the right; dragging left (lower clientX) makes it wider.
      const next = Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, startW - (e.clientX - startX)));
      panel!.style.width = `${next}px`;
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const finalWidth = panel!.offsetWidth;
      setChatPanelWidth(finalWidth);
    }

    function onMouseDown(e: MouseEvent) {
      dragging = true;
      startX = e.clientX;
      startW = panel!.offsetWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    divider.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      divider.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  }, [setChatPanelWidth]);

  return (
    <aside
      ref={panelRef}
      className="fixed inset-0 z-50 md:relative md:inset-auto md:h-auto chat-panel-responsive flex flex-col border-l border-[var(--border)] bg-[var(--surface)] flex-shrink-0 animate-slide-in-right"
      style={{ "--chat-panel-width": `${chatPanelWidth}px` } as React.CSSProperties}
    >
      {/* Drag-to-resize handle — sits on the left edge of the panel */}
      <div
        ref={dividerRef}
        className="absolute left-0 top-0 h-full w-0 flex-shrink-0 cursor-col-resize z-10 select-none hidden md:block"
        style={{ marginLeft: -3, padding: "0 3px" }}
        aria-hidden
      />
      <SessionPane isRightPanel={true} chatPrefill={prefill} onPrefillConsumed={onPrefillConsumed} />
    </aside>
  );
}
