import { listBreakoutBricks } from "@/db/queries";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import type { Label } from "@/games/pixel/kinds";
import { StackerRenderer } from "@/games/stacker/render";
import { StackerSim, type StackerEvent } from "@/games/stacker/sim";

/** The workspace's projects, notes, tasks and tags, interleaved; demo labels when it's empty. */
function workspaceLabels(): Label[] {
  try {
    return listBreakoutBricks(60);
  } catch {
    return [];
  }
}

function createStacker({ width, height, hud, best }: PixelGameSpec): PixelGame<StackerEvent> {
  const sim = new StackerSim({ width, height, hud, best, labels: workspaceLabels() });
  const renderer = new StackerRenderer(sim);
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
    down: () => sim.tap(),
    move: () => {},
  };
}

function onEvent(e: StackerEvent): void {
  switch (e) {
    case "start": return haptics.impactMedium();
    case "perfect": return haptics.impactHeavy();
    case "slice": return haptics.impact();
    case "over": return haptics.error();
    case "drop": return;
  }
}

/**
 * Hidden easter-egg stacking game (the `/stacker` route): each stone is one of
 * the workspace's projects, notes, tasks or tags. Tap to drop; the overhang is
 * sliced off, perfect drops build a combo, a miss topples the cairn.
 */
export function StackerView() {
  return <PixelGameView create={createStacker} bestKey="stacker_best" onEvent={onEvent} />;
}
