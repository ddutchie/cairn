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
    activeContextPanel,
    chatPanelResizing,
    setChatPanelResizing,
    shellVariant,
  } = useCairnStore(useShallow((s) => ({
    activeView: s.activeView,
    sessionPresentation: s.sessionPresentation,
    chatOpen: s.chatOpen,
    setChatPanelWidth: s.setChatPanelWidth,
    sidebarCollapsed: s.sidebarCollapsed,
    activePreviewItem: s.activePreviewItem,
    activeContextPanel: s.activeContextPanel,
    chatPanelResizing: s.chatPanelResizing,
    setChatPanelResizing: s.setChatPanelResizing,
    shellVariant: s.shellVariant,
  })));

  const panelRef = useRef<HTMLElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);

  const isCenterMode = sessionPresentation === "center";

  // ── Drawer ↔ center slide ───────────────────────────────────────────────
  // Both modes pin explicit left+width (drawer: right-anchored via
  // left:100vw-panelWidth; center: sidebarWidth…100vw), so a mode switch
  // interpolates one continuous slide instead of snapping. Duration/easing
  // match the content margin transition in page.tsx (300ms ease-in-out) so
  // panel and background travel together as a single motion. SessionPane
  // stays mounted throughout, preserving IPC, scroll, and chat state; the
  // centered transcript/composer are max-w-3xl mx-auto, i.e. fluid below
  // 768px, so content reflows smoothly into place mid-slide.
  // left/width only transition while the store's chatSliding flag is set —
  // it is committed atomically WITH the geometry change (a component-state
  // flag would land a frame late via effects, after the snap already
  // happened). The sidebar's own collapse/expand animation never sets the
  // flag, so live measurement tracking stays per-frame with no chasing lag.
  const chatSliding = useCairnStore((s) => s.chatSliding);
  const setChatSliding = useCairnStore((s) => s.setChatSliding);
  useEffect(() => {
    if (!chatSliding) return;
    const t = setTimeout(() => setChatSliding(false), 320);
    return () => clearTimeout(t);
  }, [chatSliding, setChatSliding]);

  // ── Live sidebar measurement ────────────────────────────────────────────
  // Center mode offsets from the sidebar's REAL rendered width instead of
  // trusting the hardcoded per-shell fallback below (those drift — the
  // collapsed dock was guessed as 4rem when it renders w-12/3rem, and the
  // rem guesses for px-based sidebars only hold at a 16px root while the app
  // runs 14px × font-scale). ResizeObserver also fires per-frame through the
  // sidebar's own 300ms collapse/expand animation, so the panel edge stays
  // glued while it moves. Re-runs on every mode switch: React's style prop
  // would otherwise clobber the measured value with the fallback on re-entry
  // (ResizeObserver alone won't refire without a size change). Runs in every
  // mode so the value is already correct the moment a switch starts; mobile
  // ignores it (panel is left-0 below md).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const sidebar = document.querySelector<HTMLElement>("[data-sidebar]");
    if (!sidebar) return;
    const sync = () => {
      panel.style.setProperty("--sidebar-width", `${sidebar.getBoundingClientRect().width}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(sidebar);
    return () => ro.disconnect();
  }, [shellVariant, isCenterMode]);

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

  // Determine positioning coordinates. Both modes pin explicit left+width so
  // mode switches slide (see above); drawer open/close stays a slide+fade via
  // transform/opacity. No viewport scrollbar exists (app is overflow-hidden by
  // construction), so 100vw-anchoring the drawer is exact.
  //
  // The --sidebar-width fallback below is per-shell and only a first-paint
  // stand-in (rem guesses can't match px-based sidebars under font scaling);
  // the live measurement effect above overwrites it with real pixels. It is
  // set in BOTH modes so React never drops the property (which would wipe
  // the measured value on every drawer visit).
  let sidebarWidth: string;
  if (shellVariant === "A") sidebarWidth = sidebarCollapsed ? "3rem" : "15.25rem";
  else if (shellVariant === "B") sidebarWidth = "16.25rem";
  else if (shellVariant === "C") sidebarWidth = "3.25rem";
  else sidebarWidth = sidebarCollapsed ? "3rem" : "14rem";
  const widthStyle = {
    "--sidebar-width": sidebarWidth,
  } as React.CSSProperties;

  let positioningClasses = "";

  if (isCenterMode) {
    // Center mode: spans from the right of the sidebar to the right screen edge.
    // top overlaps the header's border-b by 1px so the two 1px lines occupy the
    // same pixel row (y=43-44, or banner-adjusted chromeTop). Result is a single
    // 1px continuous line, not two adjacent 1px lines (2px).
    positioningClasses = "top-[calc(var(--chrome-top)-1px)] left-0 md:left-[var(--sidebar-width)] right-0 w-[100vw] md:w-[calc(100vw_-_var(--sidebar-width))] border-t border-[var(--border)] bg-[var(--background)]";
  } else {
    // Drawer mode. Right-anchored via explicit left (100vw − panel width) so
    // left+width interpolate with center mode. Width comes from the :root
    // `--chat-panel-width` variable (shared with the content margin) so the
    // drag reflows both live.
    // top -1px overlaps header's border-b (both 1px at y=43-44) -> single 1px
    // line continuous across the window. border-t + border-l meet at a clean
    // 90° corner (same element, same color, overlapping pixel, no step).
    positioningClasses = "top-[calc(var(--chrome-top)-1px)] left-[calc(100vw_-_var(--chat-panel-width,320px))] w-[var(--chat-panel-width,320px)] border-t border-l border-[var(--border)] bg-[var(--surface)] shadow-[-12px_0_32px_rgba(0,0,0,.28)]";
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
        "fixed bottom-0 z-30 flex overflow-hidden",
        // Drawer open/close always slides+fades; left/width join the transition
        // only during a drawer↔center switch (see `chatSliding` above).
        !chatPanelResizing && (chatSliding
          ? "transition-[transform,opacity,left,width] duration-300 ease-in-out"
          : "transition-[transform,opacity] duration-300 ease-in-out"),
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
      {isCenterMode && (activeContextPanel ?? activePreviewItem) && <PreviewPane />}
    </aside>
  );
}
