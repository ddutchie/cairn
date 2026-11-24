import { loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { WayfinderRenderer } from "@/games/wayfinder/render";
import { WayfinderSim, type WayfinderEvent } from "@/games/wayfinder/sim";

function createWayfinder({ width, height, hud, best }: PixelGameSpec): PixelGame<WayfinderEvent> {
  const { projects } = loadArcadeProjects();
  const sim = new WayfinderSim({ width, height, projects, hud, best });
  const renderer = new WayfinderRenderer(sim);
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
    case "start": return haptics.impactMedium();
    case "chart": return haptics.selection();
    case "lost": return haptics.impact();
    case "load": return haptics.selection();
    case "deliver": return haptics.impactMedium();
    case "late": return haptics.warning();
    case "aground": return haptics.impact();
    case "kraken": return haptics.error();
    case "escape": return haptics.success();
    case "catch": return haptics.selection();
    case "done": return haptics.success();
  }
}

/**
 * Hidden easter-egg Wayfinder (the `/wayfinder` route): sail your notes as
 * islands, deliver today's tasks to their project harbours, and chart notes
 * hidden in the fog.
 */
export function WayfinderView() {
  return <PixelGameView create={createWayfinder} bestKey="wayfinder_best" onEvent={onEvent} />;
}
