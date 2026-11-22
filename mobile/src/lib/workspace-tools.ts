import { useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";
import { WIDE_MIN_WIDTH } from "@/lib/layout";
import { usePathname, type Href } from "expo-router";
import { getMeta, setMeta } from "@/db";
import { loadPeople, loadTeams } from "@/db/people";

/** Where the Workspace tab sends you, and what the pinned accessory can show. */
export type ToolId = "people" | "graph" | "usage" | "sync";

export interface WorkspaceTool {
  id: ToolId;
  title: string;
  href: Href;
  /** What the row says when there is no live line. */
  blurb: string;
}

export const WORKSPACE_TOOLS: Record<ToolId, WorkspaceTool> = {
  people: { id: "people", title: "People", href: "/workspace/people" as Href, blurb: "Who you work with, and their teams" },
  graph: { id: "graph", title: "Knowledge graph", href: "/workspace/graph" as Href, blurb: "Projects, notes and tasks as a map" },
  usage: { id: "usage", title: "Usage", href: "/workspace/usage" as Href, blurb: "AI tokens and cost" },
  sync: { id: "sync", title: "Sync", href: "/workspace/sync" as Href, blurb: "Devices and the shared folder" },
};

/** Space the pinned accessory takes above the tab bar, so screens end above it. */
export const ACCESSORY_HEIGHT = 56;

export const PINNABLE: ToolId[] = ["people", "graph", "usage"];

/** One live line for a tool, or its blurb when there is nothing to count. Cheap, synchronous SQLite. */
export function liveLine(id: ToolId): string {
  try {
    if (id === "people") {
      const people = loadPeople().length;
      const teams = loadTeams().length;
      const p = `${people} ${people === 1 ? "person" : "people"}`;
      return teams > 0 ? `${p}, ${teams} ${teams === 1 ? "team" : "teams"}` : p;
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
    cache = v && (PINNABLE as string[]).includes(v) ? (v as ToolId) : null;
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

export const TOOL_SYMBOL = {
  people: "person.2",
  graph: "point.3.connected.trianglepath.dotted",
  usage: "chart.bar",
  sync: "arrow.triangle.2.circlepath",
} as const satisfies Record<ToolId, string>;

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
