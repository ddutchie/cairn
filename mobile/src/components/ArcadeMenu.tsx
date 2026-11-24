import { useCallback } from "react";
import { useRouter, type Href } from "expo-router";
import { getMeta } from "@/db";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { ArcadeRenderer } from "@/games/arcade/render";
import { ArcadeMenu, type ArcadeEvent, type ArcadeGameId } from "@/games/arcade/menu";

/** Best-score meta keys of each game (see their views). */
const BEST_KEYS: Record<ArcadeGameId, string> = { "task-force": "taskforce_best", stacker: "stacker_best", breakout: "breakout_best" };

function readBest(key: string): number {
  const n = parseInt(getMeta(key) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function createArcade({ width, height, hud }: PixelGameSpec): PixelGame<ArcadeEvent> {
  const bests = Object.fromEntries(Object.entries(BEST_KEYS).map(([id, key]) => [id, readBest(key)]));
  const menu = new ArcadeMenu({ width, height, hud, bests });
  const renderer = new ArcadeRenderer(menu);
  return {
    events: menu.events,
    best: 0,
    get calm() {
      return menu.calm;
    },
    set calm(v) {
      menu.calm = v;
    },
    step: () => menu.step(),
    draw: () => renderer.draw(),
    down: (x, y) => menu.down(x, y),
    move: () => {},
  };
}

/** The pixel game picker behind the secret menu (the `/arcade` route). */
export function ArcadeView() {
  const router = useRouter();
  const onEvent = useCallback(
    (e: ArcadeEvent) => {
      if (e === "select") return haptics.impactMedium();
      // Swap the arcade for the game, so Close goes straight back to the app.
      router.replace(`/${e.slice("open:".length)}` as Href);
    },
    [router],
  );
  return <PixelGameView create={createArcade} bestKey="arcade_best" onEvent={onEvent} />;
}
