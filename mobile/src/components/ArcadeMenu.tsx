import { useCallback, useEffect } from "react";
import { useRouter, type Href } from "expo-router";
import { getMeta } from "@/db";
import { unlockArcade } from "@/lib/workspace-tools";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { ArcadeMenu, CARTRIDGES, type ArcadeEvent, type ArcadeGameId } from "@cairn/shared/arcade/menu";
import { ArcadeRenderer } from "@cairn/shared/arcade/menu-render";
import { warmWayfinderSea } from "@cairn/shared/arcade/wayfinder/sim";

function readBest(key: string): number {
  const n = parseInt(getMeta(key) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function createArcade({ width, height, hud }: PixelGameSpec): PixelGame<ArcadeEvent> {
  const bests = Object.fromEntries(CARTRIDGES.map((c) => [c.id, readBest(c.bestKey)])) as Partial<Record<ArcadeGameId, number>>;
  const menu = new ArcadeMenu({ width, height, hud, inputMode: "touch", bests });
  const renderer = new ArcadeRenderer(skiaBackend, menu);
  return {
    events: menu.events,
    best: 0,
    get calm() {
      return menu.calm;
    },
    set calm(v) {
      menu.calm = v;
    },
    step: () => {
      menu.step();
      // A slice of Wayfinder's sea per frame, so that game opens faster.
      warmWayfinderSea();
    },
    draw: () => renderer.draw(),
    down: (x, y) => menu.down(x, y),
    move: () => {},
  };
}

/** The pixel game picker behind the secret menu (the `/arcade` route). */
export function ArcadeView() {
  const router = useRouter();
  // Anyone who reaches the arcade (the easter egg, or a pin) has unlocked it.
  useEffect(unlockArcade, []);
  const onEvent = useCallback(
    (e: ArcadeEvent) => {
      if (e === "select") return haptics.impactMedium();
      if (e === "page") return haptics.selection();
      if (e.startsWith("open:")) {
        router.replace(`/${e.slice("open:".length)}` as Href);
      }
    },
    [router],
  );
  return <PixelGameView create={createArcade} bestKey="arcade_best" onEvent={onEvent} />;
}
