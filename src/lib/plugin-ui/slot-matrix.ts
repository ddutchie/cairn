/**
 * Cairn Slot Matrix — the authoritative map of WHERE a UI plugin may render.
 *
 * Modelled on dsh's ui-slots SlotMap (an empty interface that packages
 * declaration-merge into): one table, declaration = render authorization. Here
 * it is a concrete, closed enum because Cairn owns its whole frontend — a plugin
 * can only mount into a slot Cairn has DECLARED and rendered a host for. This is
 * the single source of truth for the plugin-UI contract; extend it deliberately.
 *
 * Axes (per dsh):
 *  - kind:  'list'  = additive; many entries render together (overlays, bars).
 *           'keyed' = one entry per key (e.g. a tool name); dispatch picks it.
 *           'single'= exactly one occupant (takeover).
 *  - scope: 'app'    = frame-wide; no session/thread data.
 *           'view'   = tied to the active view (notes/board/...).
 *           'thread' = tied to the active chat thread (has usage/context data).
 *           'turn'   = tied to one tool call within a turn.
 *
 * Each slot documents the PROPS its components receive — the plugin data
 * contract. Components are plain React; theming is via Cairn's `--*` tokens (dsh
 * plugins get a scoped `--dsw-*` shim, see src/lib/dsh-toolview).
 */
import type { ComponentType } from "react";

export type SlotKind = "list" | "keyed" | "single";
export type SlotScope = "app" | "view" | "thread" | "turn";

/** Cairn's active-view union (mirrors the store's ActiveView). */
export type CairnView =
  | "overview" | "notes" | "board" | "calendar" | "calendar-all" | "flow" | "graph"
  | "insights" | "automations" | "usage" | "agent" | "chat" | "search" | "settings";

/** Props delivered to each slot's components — the plugin data contract. */
export interface SlotProps {
  /** Frame-wide floating layer (badges, toasts, a bouncing cat…). Click-through
   *  by default; a component opts back into pointer events on its own element. */
  "app.overlay": { activeView: CairnView; activeProjectId: string | null };
  /** Persistent status bar along the app's bottom edge. */
  "app.statusbar": { activeView: CairnView; activeProjectId: string | null };
  /** Extra rows at the bottom of the left sidebar. */
  "sidebar.footer": Record<string, never>;
  /** Action buttons in the active view's header. */
  "view.header.actions": { view: CairnView };
  /** Per-tool rich view in the chat transcript (dsh tool.call.toolview parity). */
  "tool.call.toolview": import("../dsh-toolview/contract").ToolCallViewProps;
  "chat.transcript.footer": {
    threadId: string | null;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      costUsd?: number;
      contextTokens?: number;
      contextLimit?: number;
      contextWindow?: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      breakdown?: import("../../types").TokenBreakdown;
    };
    /**
     * dsh session-projection accessor, so a purely dsh-native client plugin
     * (which reads `ctx`/props `useProjection('tokenUsage'|'contextPressure'|
     * 'contextBreakdown')`) works verbatim in Cairn. Cairn synthesises the dsh
     * token-meter view shapes from its own live usage — the plugin needs no
     * Cairn-specific code. Returns undefined for keys Cairn doesn't model.
     */
    useProjection?: (key: string) => unknown;
  };
  /** A section in the Settings view. */
  "settings.section": Record<string, never>;
}

export type SlotName = keyof SlotProps;

/** Metadata per slot — kind + scope, for the registry + docs/inventory. */
export const SLOT_MATRIX: { [K in SlotName]: { kind: SlotKind; scope: SlotScope; description: string } } = {
  "app.overlay": { kind: "list", scope: "app", description: "Frame-wide click-through floating layer (badges, toasts, animations)." },
  "app.statusbar": { kind: "list", scope: "app", description: "Persistent bottom status bar." },
  "sidebar.footer": { kind: "list", scope: "app", description: "Extra rows at the sidebar bottom." },
  "view.header.actions": { kind: "list", scope: "view", description: "Action buttons in the active view header." },
  "tool.call.toolview": { kind: "keyed", scope: "turn", description: "Per-tool rich view in the chat transcript (keyed by tool name)." },
  "chat.transcript.footer": { kind: "list", scope: "thread", description: "Band under the chat composer; cost/context widgets." },
  "settings.section": { kind: "list", scope: "app", description: "A section in the Settings view." },
};

/** A registered slot component (typed by its slot's props). */
export type SlotComponent<K extends SlotName> = ComponentType<SlotProps[K]>;

export const ALL_SLOTS = Object.keys(SLOT_MATRIX) as SlotName[];
