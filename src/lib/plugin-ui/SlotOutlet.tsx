/**
 * Slot hosts — the React components Cairn mounts at each declared slot, which
 * render whatever plugins have registered there. This is the "declaration =
 * render authorization" side: a plugin can only appear where Cairn renders an
 * outlet.
 */
"use client";
import React from "react";
import type { SlotName, SlotProps } from "./slot-matrix";
import { useSlotEntries, slotHasKey } from "./registry";
/** Render every registered component for a LIST slot (overlay, statusbar, …). */
export function SlotOutlet<K extends SlotName>({ name, props }: { name: K; props: SlotProps[K] }) {
  const entries = useSlotEntries(name);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((e) => {
        const C = e.component as React.ComponentType<SlotProps[K]>;
        return <PluginBoundary key={e.id} id={e.id}><C {...props} /></PluginBoundary>;
      })}
    </>
  );
}

/** Render the single KEYED entry matching `matchKey` (e.g. a tool name). */
export function KeyedSlotOutlet<K extends SlotName>({ name, matchKey, props }: { name: K; matchKey: string; props: SlotProps[K] }) {
  const entries = useSlotEntries(name);
  const hit = entries.find((e) => e.key === matchKey);
  if (!hit) return null;
  const C = hit.component as React.ComponentType<SlotProps[K]>;
  return <PluginBoundary id={hit.id}><C {...props} /></PluginBoundary>;
}

export function hasKeyedEntry(name: SlotName, matchKey: string): boolean {
  return slotHasKey(name, matchKey);
}

/** A single plugin component must never crash the app — isolate its failures. */
class PluginBoundary extends React.Component<{ id: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.error(`[plugin-ui] component '${this.props.id}' crashed:`, err); }
  render() { return this.state.failed ? null : this.props.children; }
}

/**
 * The frame-wide floating overlay layer — a fixed, click-through <div> spanning
 * the whole app, rendering all `app.overlay` entries. Mounted once at the app
 * root (page.tsx). Click-through: the layer ignores pointer events; each entry
 * opts back in on its own element. This is where a "bouncing cat", a badge, or a
 * toast belongs.
 */
export function AppOverlayLayer(props: SlotProps["app.overlay"]) {
  return (
    <div
      data-app-overlay
      style={{ position: "fixed", inset: 0, zIndex: 60, pointerEvents: "none" }}
    >
      <SlotOutlet name="app.overlay" props={props} />
    </div>
  );
}

/**
 * The persistent status bar along the app's bottom edge — renders all
 * `app.statusbar` entries in a thin row. Renders nothing when empty (so the
 * layout is unaffected until a plugin adds something).
 */
export function AppStatusBar(props: SlotProps["app.statusbar"]) {
  return <StatusBarInner props={props} />;
}

function StatusBarInner({ props }: { props: SlotProps["app.statusbar"] }) {
  const entries = useSlotEntries("app.statusbar");
  if (entries.length === 0) return null;
  return (
    <div
      data-app-statusbar
      className="flex items-center gap-3 px-3 h-6 text-[0.714rem] text-[var(--text-tertiary)] bg-[var(--surface-1)] border-t border-[var(--border)] shrink-0"
    >
      <SlotOutlet name="app.statusbar" props={props} />
    </div>
  );
}

/**
 * The band under the chat composer (chat.transcript.footer) — cost/context
 * widgets. Renders nothing (and adds no spacing) when no plugin has registered,
 * so the composer sits flush by default; when populated it gets a small gap
 * above the input.
 */
export function ChatFooterSlot(props: SlotProps["chat.transcript.footer"]) {
  const entries = useSlotEntries("chat.transcript.footer");
  if (entries.length === 0) return null;
  return (
    <div data-chat-footer className="mb-2 flex flex-col gap-1">
      <SlotOutlet name="chat.transcript.footer" props={props} />
    </div>
  );
}
