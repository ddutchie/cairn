import { listBreakoutBricks } from "@/db/queries";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { BreakoutRenderer } from "@/games/breakout/render";
import { BreakoutSim, MAX_COLS, ROWS, type BreakoutEvent } from "@/games/breakout/sim";
import type { Label } from "@/games/pixel/kinds";

function brickLabels(): Label[] {
  try {
    return listBreakoutBricks(ROWS * MAX_COLS);
  } catch {
    return [];
  }
}

function createBreakout({ width, height, hud, best }: PixelGameSpec): PixelGame<BreakoutEvent> {
  const sim = new BreakoutSim({ width, height, hud, best, labels: brickLabels() });
  const renderer = new BreakoutRenderer(sim);
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
    // The paddle follows the finger; a tap also starts, launches or replays.
    down: (x) => {
      sim.aim(x);
      sim.tap();
    },
    move: (x) => sim.aim(x),
  };
}

function onEvent(e: BreakoutEvent): void {
  switch (e) {
    case "start": return haptics.impactMedium();
    case "launch": return haptics.selection();
    case "brick": return haptics.impact();
    case "streak": return haptics.impactMedium();
    case "paddle": return haptics.selection();
    case "over": return haptics.error();
    case "win": return haptics.success();
  }
}

/**
 * Hidden easter-egg Breakout (the `/breakout` route): the bricks are the
 * workspace's projects, notes, tasks and tags, stacked blocks floating over a
 * drifting island.
 */
export function BreakoutView() {
  return <PixelGameView create={createBreakout} bestKey="breakout_best" onEvent={onEvent} />;
}
