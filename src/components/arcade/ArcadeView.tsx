"use client";

/**
 * The Cairn Arcade: an easter egg. Five clicks on the workspace icon in the
 * sidebar unlock it; the games read the workspace (projects, tasks, notes,
 * tags) and never write to it.
 */

import { useMemo, useState } from "react";
import { ArrowLeft, EyeOff } from "lucide-react";
import { useCairnStore } from "@/store";
import { IconButton } from "@/components/ui/icon-button";
import { ViewToolbar } from "@/components/ui/view-toolbar";
import { Tooltip } from "@/components/ui/tooltip";
import { buildArcadeData } from "./data";
import type { ArcadeGameId, GameFactory } from "./game";
import { PixelScreen } from "./PixelScreen";
import { CARTRIDGES, createArcadeMenu } from "./games/menu";
import { createBreakout } from "./games/breakout";
import { createStacker } from "./games/stacker";
import { createTaskForce } from "./games/task-force";
import { createWayfinder } from "./games/wayfinder";
import { createInboxZero } from "./games/inbox-zero";

const GAMES: Record<ArcadeGameId, GameFactory> = {
  "task-force": createTaskForce,
  stacker: createStacker,
  breakout: createBreakout,
  wayfinder: createWayfinder,
  "inbox-zero": createInboxZero,
};

export function ArcadeView() {
  const [game, setGame] = useState<ArcadeGameId | null>(null);
  const setArcadeUnlocked = useCairnStore((s) => s.setArcadeUnlocked);
  const setView = useCairnStore((s) => s.setView);

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

  const menu = useMemo(() => createArcadeMenu((id) => setGame(id)), []);
  const title = game ? CARTRIDGES.find((c) => c.id === game)?.name : undefined;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <ViewToolbar
        title={
          <span className="flex items-center gap-1.5">
            {game && (
              <IconButton label="Back to the arcade" onClick={() => setGame(null)} className="size-auto p-1">
                <ArrowLeft size={13} />
              </IconButton>
            )}
            {title ? `Arcade · ${title}` : "Arcade"}
          </span>
        }
        description={data.demo ? "Playing with a demo workspace (yours is a bit empty)" : "Your workspace, as games. Nothing here changes it."}
        actions={
          <>
            <span className="text-2xs text-[var(--text-tertiary)]">{game ? "Esc for the menu" : "Pick a game"}</span>
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
      {game ? (
        <PixelScreen key={game} id={game} factory={GAMES[game]} data={data} onExit={() => setGame(null)} />
      ) : (
        <PixelScreen key="menu" id="menu" factory={menu} data={data} />
      )}
    </div>
  );
}
