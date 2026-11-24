import { loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { InboxZeroRenderer } from "@/games/inbox-zero/render";
import { InboxZeroSim, type InboxZeroEvent } from "@/games/inbox-zero/sim";

function createInboxZero({ width, height, hud, best }: PixelGameSpec): PixelGame<InboxZeroEvent> {
  const { projects } = loadArcadeProjects();
  const sim = new InboxZeroSim({ width, height, projects, hud, best });
  const renderer = new InboxZeroRenderer(sim);
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

function onEvent(e: InboxZeroEvent): void {
  switch (e) {
    case "start": return haptics.impactMedium();
    case "place": return haptics.selection();
    case "upgrade": return haptics.impact();
    case "error": return haptics.warning();
    case "triage": return haptics.impact();
    case "leak": return haptics.error();
    case "wave": return haptics.selection();
    case "win": return haptics.success();
    case "over": return haptics.error();
  }
}

/**
 * Hidden easter-egg Inbox Zero (the `/inbox-zero` route): tower defence over
 * your board where each project is a wave of open tasks crawling toward the
 * deadline.
 */
export function InboxZeroView() {
  return <PixelGameView create={createInboxZero} bestKey="inboxzero_best" onEvent={onEvent} />;
}
