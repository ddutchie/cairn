import { listBreakoutBricks } from "@/db/queries";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import type { Label } from "@cairn/shared/arcade/pixel/kinds";
import { StackerRenderer } from "@cairn/shared/arcade/stacker/render";
import { StackerSim, type StackerEvent } from "@cairn/shared/arcade/stacker/sim";

function workspaceLabels(): Label[] {
  try {
    return listBreakoutBricks(60);
  } catch {
    return [];
  }
}

function createStacker({ width, height, hud, best }: PixelGameSpec): PixelGame<StackerEvent> {
  const sim = new StackerSim({ width, height, hud, inputMode: "touch", best, labels: workspaceLabels() });
  const renderer = new StackerRenderer(skiaBackend, sim);
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
    case "start":
      return haptics.impactMedium();
    case "perfect":
      return haptics.impactHeavy();
    case "slice":
      return haptics.impact();
    case "over":
      return haptics.error();
    case "drop":
      return;
  }
}

/**
 * Hidden easter-egg stacking game (`/stacker`): each stone is a workspace
 * project, note, task or tag.
 */
export function StackerView() {
  return <PixelGameView create={createStacker} bestKey="stacker_best" onEvent={onEvent} />;
}
