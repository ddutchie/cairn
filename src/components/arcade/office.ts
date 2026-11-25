/**
 * The Workspace (idle office) on desktop: builds the office from the store,
 * keeps it live as the workspace changes, and opens a clicked task or note in
 * the side preview pane. The office itself never writes anything.
 */

import { buildOffice } from "@cairn/shared/arcade/workspace/build";
import { toDateKey } from "@cairn/shared/arcade/workspace/week";
import type { OfficeData } from "@cairn/shared/arcade/workspace/data";
import type { Ref } from "@cairn/shared/arcade/workspace/layout";
import { cairnRefFromMeta } from "@cairn/shared/agent/session-event-fold";
import { OfficeRenderer } from "@cairn/shared/arcade/workspace/render";
import { OfficeSim } from "@cairn/shared/arcade/workspace/sim";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import { noteFilesClient } from "@/lib/ipc/notes";
import { sessionClient } from "@/lib/ipc/session";
import { useCairnStore } from "@/store";
import type { GameFactory } from "./game";
import { createCanvasBackend } from "./pixel/canvas-backend";

type StoreState = ReturnType<typeof useCairnStore.getState>;

export function officeFromStore(s: StoreState = useCairnStore.getState()): OfficeData {
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  return buildOffice({
    workspaceName: ws?.name ?? "Workspace",
    workspaceId: s.activeWorkspaceId,
    projects: s.projects,
    columns: s.columns,
    cards: s.cards,
    notes: s.notes,
  });
}

/** Store slices the office mirrors; a change to any of them rebuilds it. */
const watched = (s: StoreState) => [s.projects, s.columns, s.cards, s.notes, s.workspaces, s.activeWorkspaceId] as const;

/** How long a burst of changes (an agent editing ten cards) settles before the office redraws them. */
const SETTLE_MS = 250;

/** Milestone plants, per workspace (the demo office shares the workspace's set). */
const decorKey = (wsId: string | null) => `office_decor:${wsId ?? "default"}`;
function loadDecor(wsId: string | null): string[] {
  try {
    const raw = localStorage.getItem(decorKey(wsId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveDecor(wsId: string | null, ids: string[]): void {
  try {
    localStorage.setItem(decorKey(wsId), JSON.stringify(ids));
  } catch {
    // Cosmetic only: the plants come back next session.
  }
}

export function makeOfficeFactory(open: (ref: Ref) => void, onAgent: () => void = () => useCairnStore.getState().setView("agent")): GameFactory {
  return ({ canvas, width, height }) => {
    let wsId = useCairnStore.getState().activeWorkspaceId;
    const sim = new OfficeSim({ width, height, hud: NO_HUD, inputMode: "pointer", office: officeFromStore(), decor: loadDecor(wsId) });
    const renderer = new OfficeRenderer(createCanvasBackend(canvas), sim);
    let last = watched(useCairnStore.getState());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useCairnStore.subscribe((s) => {
      const next = watched(s);
      if (next.every((v, i) => v === last[i])) return;
      last = next;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        sim.setData(officeFromStore());
        const id = useCairnStore.getState().activeWorkspaceId;
        if (id !== wsId) {
          wsId = id;
          sim.setDecor(loadDecor(id));
        }
      }, SETTLE_MS);
    });
    // Overdue, "done this week" and the wall follow the date even if nothing is edited.
    let day = toDateKey(new Date());
    let frames = 0;
    // A note the AI is writing shows as a bubble over its desk until the write ends.
    const offStart = noteFilesClient.onAiWriteStarted(({ noteId }) => sim.setNoteWriting(noteId, true));
    const offEnd = noteFilesClient.onAiWriteEnded(({ noteId }) => sim.setNoteWriting(noteId, false));
    // The agent's tool calls drive the robot: it walks to the touched desk
    // when the call starts, and the change feed lands the change it made.
    const offEvent = sessionClient.onEvent(({ event }) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === "tool/call") {
        const ref = cairnRefFromMeta(data.meta);
        if (ref) sim.agentIntent(ref);
        return;
      }
      if (event.type === "turn/end") sim.agentIdle();
    });
    return {
      update: () => {
        sim.step();
        if (++frames % 600 === 0 && toDateKey(new Date()) !== day) {
          day = toDateKey(new Date());
          sim.setData(officeFromStore());
        }
        if (sim.decorDirty) {
          saveDecor(wsId, [...sim.decor]);
          sim.decorDirty = false;
        }
        for (const e of sim.events.splice(0)) {
          // The demo office has nothing real behind it.
          if (e.k === "open" && !sim.data.demo) open(e.ref);
          else if (e.k === "openAgent") onAgent();
        }
      },
      render: () => renderer.draw(),
      down: (x, y) => sim.down(x, y),
      move: (x, y) => sim.move(x, y),
      up: () => sim.up(),
      key: (code, down) => sim.setKey(code, down),
      resize: (w, h) => renderer.resize(w, h),
      dispose: () => {
        unsubscribe();
        offStart();
        offEnd();
        offEvent();
        if (timer) clearTimeout(timer);
      },
      best: 0,
    };
  };
}
