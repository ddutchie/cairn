import { getMeta, setMeta } from "@/db";
import { loadArcadeProjects } from "@/db/arcade";
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

function saveTank(save: AnglerSave): void {
  try {
    setMeta(TANK_KEY, JSON.stringify(save));
  } catch {
    // Not saved; the tank still holds for this visit.
  }
}

function createAngler({ width, height, hud, best }: PixelGameSpec): PixelGame<AnglerEvent> {
  const { projects, demo } = loadArcadeProjects();
  const sim = new AnglerSim({ width, height, hud, inputMode: "touch", best, projects, demo, save: loadTank() });
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
      if (sim.tankDirty) {
        sim.tankDirty = false;
        saveTank(sim.snapshot());
      }
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
