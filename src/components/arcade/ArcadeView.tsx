"use client";

/**
 * The Cairn Arcade: an easter egg. Five clicks on the workspace icon in the
 * sidebar unlock it; all game logic & pixel rendering live in @cairn/shared/arcade.
 */

import { useMemo, useState } from "react";
import { ArrowLeft, Building2, EyeOff } from "lucide-react";
import { ArcadeMenu, CARTRIDGES } from "@cairn/shared/arcade/menu";
import { ArcadeRenderer } from "@cairn/shared/arcade/menu-render";
import { BasecampRenderer } from "@cairn/shared/arcade/basecamp/render";
import { BasecampSim } from "@cairn/shared/arcade/basecamp/sim";
import { TideglassRenderer } from "@cairn/shared/arcade/tideglass/render";
import { TideglassSim } from "@cairn/shared/arcade/tideglass/sim";
import { PowderRunRenderer } from "@cairn/shared/arcade/powder-run/render";
import { PowderRunSim } from "@cairn/shared/arcade/powder-run/sim";
import { AnglerRenderer } from "@cairn/shared/arcade/angler/render";
import { AnglerSim, type AnglerSave } from "@cairn/shared/arcade/angler/sim";
import { storage } from "@/lib/storage";
import { BreakoutRenderer } from "@cairn/shared/arcade/breakout/render";
import { BreakoutSim } from "@cairn/shared/arcade/breakout/sim";
import { InboxZeroRenderer } from "@cairn/shared/arcade/inbox-zero/render";
import { InboxZeroSim } from "@cairn/shared/arcade/inbox-zero/sim";
import { NO_HUD } from "@cairn/shared/arcade/pixel/hud";
import { StackerRenderer } from "@cairn/shared/arcade/stacker/render";
import { StackerSim } from "@cairn/shared/arcade/stacker/sim";
import { buildTaskForceLevels } from "@cairn/shared/arcade/task-force/models";
import { TaskForceRenderer } from "@cairn/shared/arcade/task-force/render";
import { TaskForceSim } from "@cairn/shared/arcade/task-force/sim";
import { WayfinderRenderer } from "@cairn/shared/arcade/wayfinder/render";
import { WayfinderSim, warmWayfinderSea } from "@cairn/shared/arcade/wayfinder/sim";
import { useCairnStore } from "@/store";
import { IconButton } from "@/components/ui/icon-button";
import { ViewToolbar } from "@/components/ui/view-toolbar";
import { Tooltip } from "@/components/ui/tooltip";
import { PreviewPane } from "@/components/chat/PreviewPane";
import { buildArcadeData } from "./data";
import { makeOfficeFactory } from "./office";
import type { ArcadeGameId, GameFactory } from "./game";
import { createCanvasBackend } from "./pixel/canvas-backend";
import { loadBest, PixelScreen } from "./PixelScreen";

const createTaskForce: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new TaskForceSim({
    width,
    height,
    hud: NO_HUD,
    inputMode: "pointer",
    best,
    levels: buildTaskForceLevels(data.projects),
  });
  const renderer = new TaskForceRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: (x, y) => {
      sim.tap();
      sim.steer(x, y);
    },
    move: (x, y) => sim.steer(x, y),
    up: () => {},
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const createWayfinder: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new WayfinderSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, projects: data.projects });
  const renderer = new WayfinderRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const createInboxZero: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new InboxZeroSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, projects: data.projects });
  const renderer = new InboxZeroRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const createStacker: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new StackerSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, labels: data.labels });
  const renderer = new StackerRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: () => sim.tap(),
    move: () => {},
    up: () => {},
    key: (code, down) => {
      if (down && (code === "Space" || code === "Enter")) {
        sim.tap();
        return true;
      }
      return code === "Space";
    },
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const createBreakout: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new BreakoutSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, labels: data.labels });
  const renderer = new BreakoutRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: () => sim.tap(),
    move: (x) => sim.aim(x),
    up: () => {},
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const createBasecamp: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new BasecampSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, projects: data.projects });
  const renderer = new BasecampRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const createTideglass: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new TideglassSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, projects: data.projects });
  const renderer = new TideglassRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const createPowderRun: GameFactory = ({ canvas, width, height, data, best }) => {
  const sim = new PowderRunSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, projects: data.projects });
  const renderer = new PowderRunRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => sim.step(),
    render: () => renderer.draw(),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

/** The aquarium is kept on this device between visits (the fish, not where they swim). */
const ANGLER_TANK_KEY = "arcadeAngler:tank";

const createAngler: GameFactory = ({ canvas, width, height, data, best }) => {
  const save = storage.get<AnglerSave>(ANGLER_TANK_KEY);
  const sim = new AnglerSim({ width, height, hud: NO_HUD, inputMode: "pointer", best, projects: data.projects, demo: data.demo, liveIds: data.liveIds, save });
  const renderer = new AnglerRenderer(createCanvasBackend(canvas), sim);
  return {
    update: () => {
      sim.step();
      sim.persist((save) => storage.set(ANGLER_TANK_KEY, save));
    },
    render: () => renderer.draw(),
    down: (x, y) => sim.down(x, y),
    move: (x, y) => sim.move(x, y),
    up: () => sim.up(),
    key: (code, down) => sim.setKey(code, down),
    resize: (w, h) => renderer.resize(w, h),
    get best() {
      return sim.best;
    },
  };
};

const GAMES: Record<ArcadeGameId, GameFactory> = {
  "task-force": createTaskForce,
  stacker: createStacker,
  breakout: createBreakout,
  wayfinder: createWayfinder,
  "inbox-zero": createInboxZero,
  basecamp: createBasecamp,
  tideglass: createTideglass,
  "powder-run": createPowderRun,
  angler: createAngler,
};

function makeMenuFactory(onPick: (id: ArcadeGameId) => void, onSelect: (id: ArcadeGameId) => void): GameFactory {
  return ({ canvas, width, height }) => {
    const bests = Object.fromEntries(CARTRIDGES.map((c) => [c.id, loadBest(c.id)])) as Partial<Record<ArcadeGameId, number>>;
    const menu = new ArcadeMenu({ width, height, hud: NO_HUD, inputMode: "pointer", bests, onSelect, onPick });
    const renderer = new ArcadeRenderer(createCanvasBackend(canvas), menu);
    return {
      update: () => {
        menu.step();
        // A slice of Wayfinder's sea per frame, so that game opens faster.
        warmWayfinderSea();
      },
      render: () => renderer.draw(),
      down: (x, y) => menu.down(x, y),
      move: (x, y) => menu.move(x, y),
      up: () => {},
      key: (code, down) => {
        if (!down) return false;
        if (code === "ArrowUp" || code === "KeyW") {
          menu.selectDelta(-1);
          return true;
        }
        if (code === "ArrowDown" || code === "KeyS") {
          menu.selectDelta(1);
          return true;
        }
        if (code === "ArrowLeft" || code === "KeyA") {
          menu.setPage(menu.page - 1);
          return true;
        }
        if (code === "ArrowRight" || code === "KeyD") {
          menu.setPage(menu.page + 1);
          return true;
        }
        if (code === "Enter" || code === "Space") {
          menu.chooseSelected();
          return true;
        }
        return false;
      },
      resize: (w, h) => renderer.resize(w, h),
      best: 0,
    };
  };
}

export function ArcadeView() {
  const [game, setGame] = useState<ArcadeGameId | "workspace" | null>(null);
  const [menuSel, setMenuSel] = useState<ArcadeGameId>("task-force");
  const setArcadeUnlocked = useCairnStore((s) => s.setArcadeUnlocked);
  const setView = useCairnStore((s) => s.setView);
  const setActivePreviewItem = useCairnStore((s) => s.setActivePreviewItem);
  // The office opens tasks and notes beside itself, in the same preview pane chat uses.
  const preview = useCairnStore((s) => s.activePreviewItem ?? s.activeContextPanel);
  const centred = useCairnStore((s) => s.sessionPresentation === "center");
  const office = useMemo(() => makeOfficeFactory((ref) => setActivePreviewItem({ type: ref.type, id: ref.id }), () => setView("agent")), [setActivePreviewItem, setView]);
  const leave = () => {
    if (game === "workspace") setActivePreviewItem(null);
    setGame(null);
  };

  // Read the workspace when a game starts, not on every store change, so a
  // background sync never restarts a run.
  const data = useMemo(() => {
    const s = useCairnStore.getState();
    return buildArcadeData({
      projects: s.projects,
      notes: s.notes,
      cards: s.cards,
      columns: s.columns,
      tags: s.tags,
      workspaceId: s.activeWorkspaceId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read per game, see above
  }, [game]);

  const menu = useMemo(() => makeMenuFactory((id) => setGame(id), (id) => setMenuSel(id)), []);
  const title = game === "workspace" ? "The Workspace" : game ? CARTRIDGES.find((c) => c.id === game)?.name : undefined;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <ViewToolbar
        title={
          <span className="flex items-center gap-1.5">
            {game && (
              <IconButton label="Back to the arcade" onClick={leave} className="size-auto p-1">
                <ArrowLeft size={13} />
              </IconButton>
            )}
            {title ? `Arcade · ${title}` : "Arcade"}
          </span>
        }
        description={
          game === "workspace"
            ? "Your workspace as an office. Click a desk for its board and notes, and a card or note to open it."
            : data.demo
              ? "Playing with a demo workspace (yours is a bit empty)"
              : "Your workspace, as games. Nothing here changes it."
        }
        actions={
          <>
            <span className="text-2xs text-[var(--text-tertiary)]">{game ? "Esc for the menu" : "Pick a game"}</span>
            {!game && (
              <Tooltip content="An idle office that mirrors this workspace, live">
                <button
                  type="button"
                  onClick={() => setGame("workspace")}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                >
                  <Building2 size={12} /> The Workspace
                </button>
              </Tooltip>
            )}
            <Tooltip content="Hide the Arcade again. Five clicks on the workspace icon bring it back.">
              <button
                type="button"
                onClick={() => {
                  setArcadeUnlocked(false);
                  setView("overview");
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                <EyeOff size={12} /> Hide from sidebar
              </button>
            </Tooltip>
          </>
        }
      />
      {game === "workspace" ? (
        <div className="flex flex-1 min-h-0 min-w-0">
          <PixelScreen key="workspace" id="workspace" factory={office} data={data} onExit={leave} />
          {preview && !centred && <PreviewPane />}
        </div>
      ) : game ? (
        <PixelScreen key={game} id={game} factory={GAMES[game]} data={data} onExit={leave} />
      ) : (
        <>
          <div role="listbox" aria-label="Arcade games" className="sr-only">
            {CARTRIDGES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={menuSel === c.id}
                onClick={() => {
                  setMenuSel(c.id);
                  setGame(c.id);
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
          <PixelScreen key="menu" id="menu" factory={menu} data={data} />
        </>
      )}
    </div>
  );
}
