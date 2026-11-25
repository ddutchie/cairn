import { getMeta, setMeta } from "@/db";
import { listArcadeLiveIds, loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { AnglerRenderer } from "@cairn/shared/arcade/angler/render";
import { AnglerSim, type AnglerEvent, type AnglerSave } from "@cairn/shared/arcade/angler/sim";

// The aquarium is a per-device keepsake, so it lives in meta (never synced).
const TANK_KEY = "angler_tank";

function loadTank(): AnglerSave | null {
  try {
    const raw = getMeta(TANK_KEY);
    return raw ? (JSON.parse(raw) as AnglerSave) : null;
  } catch {
    return null;
  }
}

/** Uncapped live ids for the tank cleanup; on a read error, undefined (unknown), so the sim lets no fish go. */
function liveIds(projectIds: string[]): string[] | undefined {
  try {
    return listArcadeLiveIds(projectIds);
  } catch {
    return undefined;
  }
}

function saveTank(save: AnglerSave): boolean {
  try {
    setMeta(TANK_KEY, JSON.stringify(save));
    return true;
  } catch {
    // Not saved: the sim keeps the change and tries again shortly.
    return false;
  }
}

function createAngler({ width, height, hud, best }: PixelGameSpec): PixelGame<AnglerEvent> {
  const { projects, demo } = loadArcadeProjects();
  const sim = new AnglerSim({ width, height, hud, inputMode: "touch", best, projects, demo, liveIds: demo ? [] : liveIds(projects.map((p) => p.id)), save: loadTank() });
  const renderer = new AnglerRenderer(skiaBackend, sim);
  return {
    events: sim.events,
    get best() {
      return sim.best;
    },
    get calm() {
      return sim.calm;
    },
    set calm(v) {
      sim.calm = v;
    },
    step: () => {
      sim.step();
      sim.persist(saveTank);
    },
    draw: () => renderer.draw(),
    resize: (w, h, hud) => renderer.resize(w, h, hud),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    cancel: () => sim.cancel(),
  };
}

function onEvent(e: AnglerEvent): void {
  switch (e) {
    case "nibble":
    case "turn":
    case "select":
      return haptics.selection();
    case "bite":
      return haptics.rigid();
    case "hook":
      return haptics.impactHeavy();
    case "strain":
      return haptics.soft();
    case "tired":
      return haptics.warning();
    case "snap":
      return haptics.error();
    case "catch":
    case "keep":
      return haptics.success();
    case "cast":
    case "start":
    case "release":
      return haptics.impact();
    case "early":
    case "miss":
    case "back":
      return;
  }
}

/** Angler (`/angler`): fish your tasks and notes, keep the best in a tank that empties as work gets done. */
export function AnglerView() {
  return <PixelGameView create={createAngler} bestKey="angler_best" onEvent={onEvent} />;
}
