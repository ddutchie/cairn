import { loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { WayfinderRenderer } from "@cairn/shared/arcade/wayfinder/render";
import { WayfinderSim, type WayfinderEvent } from "@cairn/shared/arcade/wayfinder/sim";

function createWayfinder({ width, height, hud, best }: PixelGameSpec): PixelGame<WayfinderEvent> {
  const { projects } = loadArcadeProjects();
  const sim = new WayfinderSim({ width, height, hud, inputMode: "touch", best, projects });
  const renderer = new WayfinderRenderer(skiaBackend, sim);
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

function onEvent(e: WayfinderEvent): void {
  switch (e) {
    case "start":
    case "deliver":
    case "escape":
    case "dock":
    case "escape-island":
      return haptics.impactMedium();
    case "step":
    case "loot":
      return haptics.impact();
    case "attack":
      return haptics.impactHeavy();
    case "hurt":
      return haptics.warning();
    case "chart":
    case "lost":
    case "load":
    case "catch":
    case "done":
      return haptics.impact();
    case "late":
      return haptics.warning();
    case "aground":
    case "kraken":
      return haptics.impactHeavy();
  }
}

/** Wayfinder sailing easter-egg (`/wayfinder`). */
export function WayfinderView() {
  return <PixelGameView create={createWayfinder} bestKey="wayfinder_best" onEvent={onEvent} />;
}
