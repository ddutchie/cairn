import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AppState, PanResponder, StyleSheet, View } from "react-native";
import { Canvas, Image, type SkImage } from "@shopify/react-native-skia";
import { getMeta, setMeta } from "@/db";
import { useModalOpenHaptic } from "@/haptics";
import { hudFromInsets, type PixelHud } from "@/games/pixel/hud";
import { INK, SAMPLING } from "@/games/pixel/painter";
import { useCornerSafeInsets } from "@/lib/use-corner-safe-insets";
import { useMotion } from "@/lib/use-motion";

/** What the host hands a game when it (re)builds it for a playfield size. */
export interface PixelGameSpec {
  /** Playfield in game pixels. */
  width: number;
  height: number;
  /** Safe area + rounded corners, in game pixels. */
  hud: PixelHud;
  /** Persisted best score. */
  best: number;
}

/** A pixel game as the host drives it: fixed 60 Hz steps, one snapshot per frame. */
export interface PixelGame<E extends string> {
  /** Events since the last frame; the host drains this (haptics). */
  readonly events: E[];
  readonly best: number;
  /** Reduced motion: no shake, no freeze frames. */
  calm: boolean;
  step(): void;
  draw(): SkImage;
  /** Finger down at (x, y), game pixels. */
  down(x: number, y: number): void;
  /** Finger moved to (x, y); (dx, dy) since the last move. Game pixels. */
  move(x: number, y: number, dx: number, dy: number): void;
}

const STEP_MS = 1000 / 60;
/** Narrowest playfield, in game pixels; the scale factor is chosen to keep at least this. */
const MIN_GAME_W = 160;
const TARGET_GAME_H = 320;
/**
 * Most of the bottom safe area is only the home indicator, which the game can
 * draw under; reserve just this much (points) so the bottom HUD sits low.
 */
const MAX_BOTTOM_RESERVE = 12;

function loadBest(key: string): number {
  const n = parseInt(getMeta(key) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Host for the hidden pixel games (Task Force, Stacker, Breakout). Measures
 * whatever the route gives it (phone, folded or unfolded Duo), picks a
 * whole-number scale so every game pixel is the same size, builds the game for
 * that playfield, runs it at 60 Hz, scales each frame up with nearest
 * sampling, persists the best score under `bestKey` (device meta, never
 * synced) and pauses while the app is in the background.
 */
export function PixelGameView<E extends string>(props: {
  create: (spec: PixelGameSpec) => PixelGame<E>;
  bestKey: string;
  onEvent: (e: E) => void;
}) {
  useModalOpenHaptic();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((prev) => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
      }}
    >
      {size ? <Host {...props} width={size.w} height={size.h} /> : null}
    </View>
  );
}

function Host<E extends string>({
  create,
  bestKey,
  onEvent,
  width,
  height,
}: {
  create: (spec: PixelGameSpec) => PixelGame<E>;
  bestKey: string;
  onEvent: (e: E) => void;
  width: number;
  height: number;
}) {
  const safe = useCornerSafeInsets({ maxBottom: MAX_BOTTOM_RESERVE });
  const motion = useMotion();

  const k = Math.max(1, Math.min(Math.round(height / TARGET_GAME_H), Math.floor(width / MIN_GAME_W)));
  const gw = Math.ceil(width / k), gh = Math.ceil(height / k);
  const hud = useMemo(() => hudFromInsets(safe, k), [safe, k]);

  // The game lives as long as the playfield keeps its size (folding or
  // unfolding rebuilds it, keeping the best score). useState holder, not a
  // ref read during render.
  const [holder] = useState(() => ({ key: "", game: null as PixelGame<E> | null }));
  const sizeKey = `${gw}x${gh}x${Object.values(hud).join(",")}`;
  if (holder.key !== sizeKey || !holder.game) {
    holder.game = create({ width: gw, height: gh, hud, best: Math.max(loadBest(bestKey), holder.game?.best ?? 0) });
    holder.key = sizeKey;
  }
  const game = holder.game;
  game.calm = motion.reduced;

  const [frame, setFrame] = useState<SkImage | null>(null);
  const paused = useRef(AppState.currentState !== "active");
  const emit = useRef(onEvent);
  useEffect(() => {
    emit.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let raf = 0, last = performance.now(), acc = 0, saved = loadBest(bestKey);
    const tick = (now: number) => {
      acc += Math.min(100, now - last);
      last = now;
      if (paused.current) acc = 0;
      let steps = 0;
      while (acc >= STEP_MS && steps < 3) {
        game.step();
        acc -= STEP_MS;
        steps++;
      }
      if (steps === 3) acc = 0;
      if (game.events.length) {
        for (const e of game.events) emit.current(e);
        game.events.length = 0;
      }
      if (game.best > saved) {
        saved = game.best;
        setMeta(bestKey, String(saved));
      }
      setFrame(game.draw());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [game, bestKey]);

  // Pause whenever the app isn't foregrounded, so time doesn't jump on return.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      paused.current = s !== "active";
    });
    return () => sub.remove();
  }, []);

  const left = (width - gw * k) / 2;
  const pan = useMemo(() => {
    let lx = 0, ly = 0;
    const toGame = (px: number, py: number): [number, number] => [(px - left) / k, py / k];
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        lx = 0;
        ly = 0;
        game.down(...toGame(e.nativeEvent.locationX, e.nativeEvent.locationY));
      },
      onPanResponderMove: (e, g) => {
        const [x, y] = toGame(e.nativeEvent.locationX, e.nativeEvent.locationY);
        game.move(x, y, (g.dx - lx) / k, (g.dy - ly) / k);
        lx = g.dx;
        ly = g.dy;
      },
    });
  }, [game, k, left]);

  return (
    <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
      <GameCanvas image={frame} width={gw * k} height={gh * k} left={left} />
    </View>
  );
}

const GameCanvas = memo(function GameCanvas({ image, width, height, left }: { image: SkImage | null; width: number; height: number; left: number }) {
  return (
    <Canvas style={{ position: "absolute", top: 0, left, width, height }} pointerEvents="none">
      {image ? <Image image={image} x={0} y={0} width={width} height={height} fit="fill" sampling={SAMPLING} /> : null}
    </Canvas>
  );
});

const styles = StyleSheet.create({
  // The games paint every pixel with their own fixed palette; this is their
  // ink, shown only before the first frame.
  root: { flex: 1, backgroundColor: INK, overflow: "hidden" },
});
