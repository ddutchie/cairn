import { listTaskForceLevels } from "@/db/task-force";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { BIOME_ORDER } from "@cairn/shared/arcade/pixel/terrain";
import { DEMO_LEVELS, type Level } from "@cairn/shared/arcade/task-force/models";
import { TaskForceRenderer } from "@cairn/shared/arcade/task-force/render";
import { TaskForceSim, type TaskForceEvent } from "@cairn/shared/arcade/task-force/sim";

function workspaceLevels(): Level[] {
  try {
    const rows = listTaskForceLevels();
    if (!rows.length) return DEMO_LEVELS;
    return rows.map((r, i) => ({ ...r, biome: BIOME_ORDER[i % BIOME_ORDER.length] }));
  } catch {
    return DEMO_LEVELS;
  }
}

function createTaskForce({ width, height, hud, best }: PixelGameSpec): PixelGame<TaskForceEvent> {
  const sim = new TaskForceSim({ width, height, hud, inputMode: "touch", best, levels: workspaceLevels() });
  const renderer = new TaskForceRenderer(skiaBackend, sim);
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
    down() {
      sim.tap();
    },
    move(_x, _y, dx, dy) {
      if (sim.state === "play" || sim.state === "boss" || sim.state === "intro" || sim.state === "clear") {
        sim.nudge(dx, dy);
      }
    },
  };
}

function onEvent(e: TaskForceEvent): void {
  switch (e) {
    case "start":
    case "clear":
      return haptics.impactMedium();
    case "kill":
    case "pickup":
      return haptics.impact();
    case "kill-big":
    case "boss":
    case "boss-down":
      return haptics.impactHeavy();
    case "hit":
      return haptics.warning();
    case "over":
      return haptics.error();
    case "carried":
      return haptics.selection();
  }
}

/**
 * Hidden easter-egg Task Force game (the `/task-force` route): each level is
 * a project flying over its biome islands; open tasks are enemy waves.
 */
export function TaskForceView() {
  return <PixelGameView create={createTaskForce} bestKey="taskforce_best" onEvent={onEvent} />;
}
