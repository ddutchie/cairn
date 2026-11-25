import { loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { BasecampRenderer } from "@cairn/shared/arcade/basecamp/render";
import { BasecampSim, type BasecampEvent } from "@cairn/shared/arcade/basecamp/sim";

function createBasecamp({ width, height, hud, best }: PixelGameSpec): PixelGame<BasecampEvent> {
  const { projects } = loadArcadeProjects();
  const sim = new BasecampSim({ width, height, hud, inputMode: "touch", best, projects });
  const renderer = new BasecampRenderer(skiaBackend, sim);
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

function onEvent(e: BasecampEvent): void {
  switch (e) {
    case "start":
    case "build":
    case "dim":
    case "over":
    case "endure":
    case "bell":
      return haptics.impactMedium();
    case "secret":
      return haptics.impactHeavy();
    case "chop":
    case "spark":
    case "ember":
    case "sluice":
    case "log":
      return haptics.impact();
    case "phase":
    case "step":
      return haptics.selection();
  }
}

/** Basecamp cozy colony + clockwork mystery (`/basecamp`). */
export function BasecampView() {
  return <PixelGameView create={createBasecamp} bestKey="basecamp_best" onEvent={onEvent} />;
}
