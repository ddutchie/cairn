"use client";

import React, { useRef, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { SessionPane } from "@/components/agent/SessionPane";
import { PreviewPane } from "./PreviewPane";
import { cn } from "@/lib/utils";
import { MIN_CHAT_PANEL_WIDTH, MAX_CHAT_PANEL_WIDTH } from "@/store/slices/ui";

interface UnifiedChatPanelProps {
  prefill?: { text: string; autoSend?: boolean } | null;
  onPrefillConsumed?: () => void;
}

export function UnifiedChatPanel({ prefill, onPrefillConsumed }: UnifiedChatPanelProps) {
  const {
    activeView,
    sessionPresentation,
    chatOpen,
    setChatPanelWidth,
    sidebarCollapsed,
    activePreviewItem,
    chatPanelResizing,
    setChatPanelResizing,
  } = useCairnStore(useShallow((s) => ({
    activeView: s.activeView,
    sessionPresentation: s.sessionPresentation,
    chatOpen: s.chatOpen,
    setChatPanelWidth: s.setChatPanelWidth,
    sidebarCollapsed: s.sidebarCollapsed,
    activePreviewItem: s.activePreviewItem,
    chatPanelResizing: s.chatPanelResizing,
    setChatPanelResizing: s.setChatPanelResizing,
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
      // Panel is on the right; dragging left (lower clientX) makes it wider
      const next = Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, startW - (e.clientX - startX)));
      // Write the live width straight to :root so BOTH the fixed panel and the
      // centered content margin reflow instantly — no React re-render per
      // mousemove (updating the store per pixel re-renders the whole page tree
      // and can blow React's nested-update limit).
      document.documentElement.style.setProperty("--chat-panel-width", `${next}px`);
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      setChatPanelResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const finalWidth = panel!.offsetWidth;
      setChatPanelWidth(finalWidth);
    }

    function onMouseDown(e: MouseEvent) {
      dragging = true;
      setChatPanelResizing(true);
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
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // The effect tears down mid-drag when activeView changes (e.g. the user
      // switches views while resizing) — mouseup never fires. Retain the latest
      // dragged width, commit it, and clear the resizing flag so the panel
      // doesn't stay in a half-resized, transition-less state.
      if (dragging) {
        dragging = false;
        setChatPanelResizing(false);
        const live = document.documentElement.style.getPropertyValue("--chat-panel-width");
        const parsed = parseInt(live, 10);
        if (Number.isFinite(parsed)) setChatPanelWidth(parsed);
      }
    };
  }, [setChatPanelWidth, setChatPanelResizing, activeView]);

  const isCenterMode = sessionPresentation === "center";

  // Determine positioning coordinates
  let positioningClasses = "";
  let widthStyle: React.CSSProperties = {};

  if (isCenterMode) {
    // Center mode: spans from the right of the sidebar (dynamic width based on collapse status) to the right screen edge
    const sidebarWidth = sidebarCollapsed ? "3rem" : "14rem";
    positioningClasses = "left-0 md:left-[var(--sidebar-width)] right-0 w-auto border-l-0 bg-[var(--background)]";
    widthStyle = {
      "--sidebar-width": sidebarWidth,
    } as React.CSSProperties;
  } else {
    // Sidebar mode. Width comes from the :root `--chat-panel-width` variable
    // (shared with the centered content margin) so the drag reflows both live.
    positioningClasses = "right-0 border-l border-[var(--border)] bg-[var(--surface)] left-[calc(100%-var(--chat-panel-width,320px))]";
    if (chatOpen) {
      positioningClasses += " opacity-100 translate-x-0";
    } else {
      positioningClasses += " opacity-0 translate-x-full pointer-events-none";
    }
  }

  return (
    <aside
      ref={panelRef}
      className={cn(
        "fixed top-[var(--chrome-top,40px)] bottom-0 z-30 flex overflow-hidden",
        !chatPanelResizing && "transition-all duration-300 ease-in-out",
        positioningClasses
      )}
      style={widthStyle}
    >
      {/* Resizer divider handle (only shown and active in Sidebar Mode) */}
      {!isCenterMode && (
        <div
          ref={dividerRef}
          className="absolute left-0 top-0 h-full w-1 cursor-col-resize z-40 select-none hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)] transition-colors"
          style={{ marginLeft: -2 }}
          aria-hidden
        />
      )}

      {/* Main completions/agent tab panel content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <SessionPane
          isRightPanel={!isCenterMode}
          chatPrefill={prefill}
          onPrefillConsumed={onPrefillConsumed}
        />
      </div>

      {/* Side-by-side preview panel (renders only in Center Mode when note/task is clicked) */}
      {isCenterMode && activePreviewItem && <PreviewPane />}
    </aside>
  );
}
