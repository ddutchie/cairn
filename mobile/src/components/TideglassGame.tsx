import { loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { TideglassRenderer } from "@cairn/shared/arcade/tideglass/render";
import { TideglassSim, type TideglassEvent } from "@cairn/shared/arcade/tideglass/sim";

function createTideglass({ width, height, hud, best }: PixelGameSpec): PixelGame<TideglassEvent> {
  const { projects } = loadArcadeProjects();
  const sim = new TideglassSim({ width, height, hud, inputMode: "touch", best, projects });
  const renderer = new TideglassRenderer(skiaBackend, sim);
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
    step: () => sim.step(),
    draw: () => renderer.draw(),
    resize: (w, h, hud) => renderer.resize(w, h, hud),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    cancel: () => sim.cancel(),
  };
}

function onEvent(e: TideglassEvent): void {
  switch (e) {
    case "start":
    case "jam":
    case "crank":
      return haptics.impactMedium();
    case "secret":
      return haptics.impactHeavy();
    case "win":
      return haptics.impactHeavy();
    case "tune":
    case "intercept":
    case "shard":
    case "witness":
    case "drop":
    case "zone":
    case "log":
      return haptics.impact();
    case "phase":
    case "step":
      return haptics.selection();
    default:
      return haptics.selection();
  }
}

/** Tideglass lighthouse-archipelago clockwork mystery (`/tideglass`). */
export function TideglassView() {
  return <PixelGameView create={createTideglass} bestKey="tideglass_best" onEvent={onEvent} />;
}
