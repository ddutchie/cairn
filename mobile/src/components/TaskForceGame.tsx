import { listTaskForceLevels } from "@/db/task-force";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { BIOME_ORDER } from "@/games/pixel/terrain";
import { TaskForceRenderer } from "@/games/task-force/render";
import { DEMO_LEVELS, TaskForceSim, type GameEvent, type Level } from "@/games/task-force/sim";

/** Drags move the jet a little further than the finger, like a trackpad. */
const DRAG_GAIN = 1.25;

/** Each live project with open tasks is a level; biomes cycle so every level looks different. */
function buildLevels(): Level[] {
  let rows: ReturnType<typeof listTaskForceLevels> = [];
  try {
    rows = listTaskForceLevels();
  } catch {
    rows = [];
  }
  const levels = rows
    .filter((r) => r.tasks.length > 0)
    .map((r, i) => ({ name: r.name, biome: BIOME_ORDER[i % BIOME_ORDER.length], tasks: r.tasks, notes: r.notes }));
  return levels.length ? levels : DEMO_LEVELS;
}

function createTaskForce({ width, height, hud, best }: PixelGameSpec): PixelGame<GameEvent> {
  const sim = new TaskForceSim({ width, height, levels: buildLevels(), hud, best });
  const renderer = new TaskForceRenderer(sim);
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
    // A tap starts / retries / continues; a drag steers relative to the finger.
    down: () => sim.tap(),
    move: (_x, _y, dx, dy) => sim.nudge(dx * DRAG_GAIN, dy * DRAG_GAIN),
  };
}

function onEvent(e: GameEvent): void {
  switch (e) {
    case "start": return haptics.impactMedium();
    case "kill": return haptics.impact();
    case "kill-big": return haptics.impactHeavy();
    case "boss-down": return haptics.impactHeavy();
    case "hit": return haptics.error();
    case "pickup": return haptics.selection();
    case "boss": return haptics.warning();
    case "clear": return haptics.success();
    case "over": return haptics.error();
    case "carried": return;
  }
}

/**
 * Hidden easter-egg vertical shooter (the `/task-force` route). Every project
 * with open tasks is a level, its tasks are the enemy wave (priority picks the
 * ship) and its notes are pickups.
 */
export function TaskForceView() {
  return <PixelGameView create={createTaskForce} bestKey="taskforce_best" onEvent={onEvent} />;
}
