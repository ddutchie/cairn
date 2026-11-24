"use client";

/**
 * Hosts one arcade game: a canvas 320 game pixels tall, upscaled with
 * nearest-neighbour to fill the view's height. With `fit`, the canvas is as
 * wide as the view's shape allows (the phone shape at least, 480 px at most);
 * without it, it keeps the phone shape. Games that implement `resize` re-bind
 * when the container resizes; others keep their start width and rescale. A fixed
 * 60 Hz step pauses while the window is hidden; pointer input arrives in game
 * pixels, keys while mounted.
 */

import { useEffect, useRef, useState } from "react";
import { useContainerDims } from "@/lib/viz/hooks";
import { storage } from "@/lib/storage";
import type { ArcadeData } from "./data";
import type { GameFactory, PixelGame } from "./game";
import { H, MAX_W, MIN_W, bindScreen, clamp } from "./pixel/kit";

export const bestKey = (id: string) => `arcadeBest:${id}`;
export const loadBest = (id: string): number => {
  const v = storage.get<number>(bestKey(id));
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

const STEP = 1000 / 60;

export function PixelScreen({
  id,
  factory,
  data,
  fit = true,
  onExit,
}: {
  /** Best-score key. */
  id: string;
  factory: GameFactory;
  data: ArcadeData;
  /** Fill the view's width (else keep the 180-wide phone shape). */
  fit?: boolean;
  /** Escape pressed. */
  onExit?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<PixelGame | null>(null);
  const exitRef = useRef(onExit);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);
  const { width, height } = useContainerDims(boxRef);
  const [gameW, setGameW] = useState(MIN_W);
  const k = Math.max(0.5, Math.min(width / gameW, height / H));

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const scale = Math.max(0.5, box.clientHeight / H);
    bindScreen(canvas, fit ? Math.floor(box.clientWidth / scale) : MIN_W);
    setGameW(canvas.width);
    let best = loadBest(id);
    const game = factory({ data, best });
    gameRef.current = game;
    let raf = 0, last = performance.now(), acc = 0;
    const frame = (now: number) => {
      acc += Math.min(100, now - last);
      last = now;
      if (document.hidden) acc = 0;
      while (acc >= STEP) {
        game.update();
        acc -= STEP;
      }
      game.render();
      if (game.best > best) {
        best = game.best;
        storage.set(bestKey(id), best);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.type === "keydown" && e.code === "Escape" && exitRef.current) {
        e.preventDefault();
        exitRef.current();
        return;
      }
      // Held Space / Enter would re-trigger drops and launches; arrows may repeat.
      if (e.repeat && (e.code === "Space" || e.code === "Enter")) {
        e.preventDefault();
        return;
      }
      if (game.key(e.code, e.type === "keydown")) e.preventDefault();
    };
    const onUp = () => game.up();
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      gameRef.current = null;
    };
  }, [id, factory, data, fit]);

  useEffect(() => {
    if (!fit || !width || !height) return;
    const canvas = canvasRef.current;
    const game = gameRef.current;
    if (!canvas || !game?.resize) return;
    const scale = Math.max(0.5, height / H);
    const nextW = Math.round(clamp(Math.floor(width / scale), MIN_W, MAX_W));
    if (nextW === canvas.width) return;
    const prevW = canvas.width;
    bindScreen(canvas, nextW);
    setGameW(canvas.width);
    game.resize(prevW);
    game.render();
  }, [width, height, fit]);

  const toGame = (e: React.PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * gameW, ((e.clientY - r.top) / r.height) * H];
  };

  return (
    <div
      ref={boxRef}
      className="relative flex flex-1 min-h-0 min-w-0 items-center justify-center overflow-hidden bg-[var(--background)] select-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        gameRef.current?.down(...toGame(e));
      }}
      onPointerMove={(e) => gameRef.current?.move(...toGame(e))}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* No width/height props: bindScreen owns them, and React re-setting
          them would clear the canvas and its pixelated smoothing state. */}
      <canvas
        ref={canvasRef}
        className="block touch-none"
        style={{ width: gameW * k, height: H * k, imageRendering: "pixelated" }}
        aria-label="Arcade game"
      />
    </div>
  );
}
