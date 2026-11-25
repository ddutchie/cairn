import { loadArcadeProjects } from "@/db/arcade";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { InboxZeroRenderer } from "@cairn/shared/arcade/inbox-zero/render";
import { InboxZeroSim, type InboxZeroEvent } from "@cairn/shared/arcade/inbox-zero/sim";

function createInboxZero({ width, height, hud, best }: PixelGameSpec): PixelGame<InboxZeroEvent> {
  const loaded = loadArcadeProjects();
  const sim = new InboxZeroSim({
    width,
    height,
    hud,
    inputMode: "touch",
    best,
    projects: loaded.projects,
  });
  const renderer = new InboxZeroRenderer(skiaBackend, sim);
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
    down(x, y) {
      sim.down(x, y);
    },
    move(x, y) {
      sim.move(x, y);
    },
    up() {
      sim.up();
    },
    cancel() {
      sim.cancel();
    },
  };
}

function onEvent(e: InboxZeroEvent): void {
  switch (e) {
    case "start":
    case "wave":
    case "win":
      return haptics.impactMedium();
    case "place":
    case "upgrade":
      return haptics.impact();
    case "pick":
    case "triage":
      return haptics.selection();
    case "error":
    case "leak":
      return haptics.warning();
    case "over":
      return haptics.error();
  }
}

/**
 * Inbox Zero tower defence (`/inbox-zero`): pin tag towers beside the Kanban
 * flow to triage incoming tasks; drag on the board to preview AoE range.
 */
export function InboxZeroView() {
  return <PixelGameView create={createInboxZero} bestKey="inboxzero_best" onEvent={onEvent} />;
}
