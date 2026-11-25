import { useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";
import { WIDE_MIN_WIDTH } from "@/lib/layout";
import { usePathname, type Href } from "expo-router";
import { getMeta, setMeta } from "@/db";
import { loadPeople, loadTeams } from "@/db/people";
import { loadLocalToday } from "@/lib/local-today";
import { localTodayLine } from "@cairn/shared/today/local";
import { CARTRIDGES, type ArcadeGameId } from "@cairn/shared/arcade/menu";

/** Where the Workspace tab sends you, and what the pinned accessory can show. */
type BaseToolId = "today" | "people" | "graph" | "usage" | "sync";
/** The arcade and its games join the tools once the arcade is unlocked. */
export type ToolId = BaseToolId | "arcade" | ArcadeGameId;

export interface WorkspaceTool {
  id: ToolId;
  title: string;
  href: Href;
  /** What the row says when there is no live line. */
  blurb: string;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const sentenceCase = (s: string) => (s.charAt(0) + s.slice(1).toLowerCase()).replace(/\b3d\b/g, "3D");

/** The arcade picker, then every game, in menu order. */
export const ARCADE_TOOLS: ToolId[] = ["arcade", ...CARTRIDGES.map((c) => c.id)];
type ToolSymbol = "sun.max" | "person.2" | "point.3.connected.trianglepath.dotted" | "chart.bar" | "arrow.triangle.2.circlepath" | "gamecontroller";

const BEST_KEY = new Map<string, string>(CARTRIDGES.map((c) => [c.id, c.bestKey]));

export const isArcadeTool = (id: ToolId): boolean => ARCADE_TOOLS.includes(id);

export const WORKSPACE_TOOLS: Record<ToolId, WorkspaceTool> = {
  arcade: { id: "arcade", title: "Arcade", href: "/arcade" as Href, blurb: "Your workspace as pixel games" },
  ...(Object.fromEntries(
    CARTRIDGES.map((c) => [c.id, { id: c.id, title: titleCase(c.name), href: `/${c.id}` as Href, blurb: sentenceCase(c.blurb) }]),
  ) as Record<ArcadeGameId, WorkspaceTool>),
  today: { id: "today", title: "Today", href: "/workspace/today" as Href, blurb: "What needs you today" },
  people: { id: "people", title: "People", href: "/workspace/people" as Href, blurb: "Who you work with, and their teams" },
  graph: { id: "graph", title: "Knowledge graph", href: "/workspace/graph" as Href, blurb: "Projects, notes and tasks as a map" },
  usage: { id: "usage", title: "Usage", href: "/workspace/usage" as Href, blurb: "AI tokens and cost" },
  sync: { id: "sync", title: "Sync", href: "/settings/sync" as Href, blurb: "Devices and the shared folder" },
};

/** Space the pinned accessory takes above the tab bar, so screens end above it. */
export const ACCESSORY_HEIGHT = 56;

export const PINNABLE: ToolId[] = ["today", "people", "graph", "usage"];

/** The workspace tools, plus the arcade's once it is unlocked (a pin can only be set from a visible row). */
export const isPinnable = (id: string): id is ToolId => (PINNABLE as string[]).includes(id) || (ARCADE_TOOLS as string[]).includes(id);

/** One live line for a tool, or its blurb when there is nothing to count. Cheap, synchronous SQLite. */
export function liveLine(id: ToolId): string {
  try {
    if (id === "today") return localTodayLine(loadLocalToday());
    if (id === "people") {
      const people = loadPeople().length;
      const teams = loadTeams().length;
      const p = `${people} ${people === 1 ? "person" : "people"}`;
      return teams > 0 ? `${p}, ${teams} ${teams === 1 ? "team" : "teams"}` : p;
    }
    const bestKey = BEST_KEY.get(id);
    if (bestKey) {
      const best = parseInt(getMeta(bestKey) ?? "", 10);
      if (best > 0) return `Best ${best.toLocaleString()} · ${WORKSPACE_TOOLS[id].blurb}`;
    }
  } catch {
    // The DB may not be ready; fall back to the blurb.
  }
  return WORKSPACE_TOOLS[id].blurb;
}

// The pinned tool is a per-device preference, so it lives in meta (never synced).
const KEY = "workspace.pinnedTool";
const listeners = new Set<() => void>();
let cache: ToolId | null | undefined;

function read(): ToolId | null {
  if (cache === undefined) {
    let v: string | null = null;
    try {
      v = getMeta(KEY);
    } catch {
      v = null;
    }
    cache = v && isPinnable(v) ? v : null;
  }
  return cache;
}

export function setPinnedTool(id: ToolId | null): void {
  cache = id;
  try {
    setMeta(KEY, id ?? "");
  } catch {
    // Not persisted; the pin still holds for this session.
  }
  listeners.forEach((l) => l());
}

export function usePinnedTool(): ToolId | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
}

/** Space a screen should leave at the bottom for the pinned accessory, or 0 when none is showing. */
export function useAccessoryVisible(): boolean {
  return useAccessoryContext().showAccessory;
}

/** Wide windows have no accessory; the pinned tool is a toolbar button on every tab but Workspace and Chat instead. */
export function usePinnedToolForRail(): ToolId | null {
  const pinned = usePinnedTool();
  const { showRail } = useAccessoryContext();
  return showRail ? pinned : null;
}

export const TOOL_SYMBOL: Record<ToolId, ToolSymbol> = {
  today: "sun.max",
  people: "person.2",
  graph: "point.3.connected.trianglepath.dotted",
  usage: "chart.bar",
  sync: "arrow.triangle.2.circlepath",
  arcade: "gamecontroller",
  ...(Object.fromEntries(CARTRIDGES.map((c) => [c.id, "gamecontroller"])) as Record<ArcadeGameId, ToolSymbol>),
};

// Five taps on the Cairn icon unlock the arcade; from then on its games are Workspace tools.
const ARCADE_KEY = "arcade.unlocked";
const arcadeListeners = new Set<() => void>();
let arcadeCache: boolean | undefined;

function readArcade(): boolean {
  if (arcadeCache === undefined) {
    try {
      arcadeCache = getMeta(ARCADE_KEY) === "1";
    } catch {
      arcadeCache = false;
    }
  }
  return arcadeCache;
}

export function unlockArcade(): void {
  if (readArcade()) return;
  arcadeCache = true;
  try {
    setMeta(ARCADE_KEY, "1");
  } catch {
    // Not persisted; unlocked for this session.
  }
  arcadeListeners.forEach((l) => l());
}

export function useArcadeUnlocked(): boolean {
  return useSyncExternalStore(
    (cb) => {
      arcadeListeners.add(cb);
      return () => arcadeListeners.delete(cb);
    },
    readArcade,
    readArcade,
  );
}

function useAccessoryContext(): { showAccessory: boolean; showRail: boolean } {
  const pathname = usePathname();
  const inWorkspace = pathname === "/workspace" || pathname.startsWith("/workspace/");
  // Chat has its own composer at the bottom, so the accessory stays out of it.
  const inChat = pathname === "/chat" || pathname.startsWith("/chat/");
  // The system reserves the accessory's strip across the whole window, so on a wide window
  // (the unfolded Duo, two columns) it would leave an empty band under both. The tool is still
  // one tap away in the Workspace tab there.
  const wide = useWindowDimensions().width >= WIDE_MIN_WIDTH;
  return { showAccessory: !inWorkspace && !inChat && !wide, showRail: !inWorkspace && !inChat && wide };
}

export function useAccessoryInset(): number {
  const pinned = usePinnedTool();
  const visible = useAccessoryVisible();
  return pinned && visible ? ACCESSORY_HEIGHT : 0;
}
