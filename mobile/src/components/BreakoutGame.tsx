import { listBreakoutBricks } from "@/db/queries";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { BreakoutRenderer } from "@cairn/shared/arcade/breakout/render";
import { BreakoutSim, type BreakoutEvent } from "@cairn/shared/arcade/breakout/sim";
import type { Label } from "@cairn/shared/arcade/pixel/kinds";

function workspaceLabels(): Label[] {
  try {
    return listBreakoutBricks(96);
  } catch {
    return [];
  }
}

function createBreakout({ width, height, hud, best }: PixelGameSpec): PixelGame<BreakoutEvent> {
  const sim = new BreakoutSim({ width, height, hud, inputMode: "touch", best, labels: workspaceLabels() });
  const renderer = new BreakoutRenderer(skiaBackend, sim);
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
    down: () => sim.tap(),
    move: (_x, _y, dx) => sim.nudgePad(dx),
  };
}

function onEvent(e: BreakoutEvent): void {
  switch (e) {
    case "start":
    case "win":
      return haptics.impactMedium();
    case "launch":
    case "brick":
    case "paddle":
      return haptics.impact();
    case "streak":
      return haptics.impactHeavy();
    case "over":
      return haptics.error();
  }
}

/** Brick Breaker (`/breakout`). */
export function BreakoutView() {
  return <PixelGameView create={createBreakout} bestKey="breakout_best" onEvent={onEvent} />;
}
