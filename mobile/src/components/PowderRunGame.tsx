import { loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { PowderRunRenderer } from "@cairn/shared/arcade/powder-run/render";
import { PowderRunSim, type PowderEvent } from "@cairn/shared/arcade/powder-run/sim";

function createPowderRun({ width, height, hud, best }: PixelGameSpec): PixelGame<PowderEvent> {
  const { projects } = loadArcadeProjects();
  const sim = new PowderRunSim({ width, height, hud, inputMode: "touch", best, projects });
  const renderer = new PowderRunRenderer(skiaBackend, sim);
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
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
  };
}

function onEvent(e: PowderEvent): void {
  switch (e) {
    case "start":
    case "trick":
    case "land":
      return haptics.impactMedium();
    case "hurt":
    case "clear":
    case "win":
      return haptics.impactHeavy();
    default:
      return haptics.selection();
  }
}

/** Powder Run 3D halfpipe snowboard game (`/powder-run`). */
export function PowderRunView() {
  return <PixelGameView create={createPowderRun} bestKey="powderrun_best" onEvent={onEvent} />;
}
