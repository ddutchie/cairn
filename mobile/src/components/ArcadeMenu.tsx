import { useCallback } from "react";
import { useRouter, type Href } from "expo-router";
import { getMeta } from "@/db";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { ArcadeMenu, CARTRIDGES, type ArcadeEvent, type ArcadeGameId } from "@cairn/shared/arcade/menu";
import { ArcadeRenderer } from "@cairn/shared/arcade/menu-render";

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
      router.replace(`/${e.slice("open:".length)}` as Href);
    },
    [router],
  );
  return <PixelGameView create={createArcade} bestKey="arcade_best" onEvent={onEvent} />;
}
