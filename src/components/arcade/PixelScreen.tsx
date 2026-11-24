"use client";

/**
 * Hosts one arcade game: a canvas 320 game pixels tall, upscaled with
 * nearest-neighbour interpolation, stepping at 60 Hz with localStorage best
 * score persistence and live resize handling.
 */

import { useEffect, useRef, useState } from "react";
import { clamp } from "@cairn/shared/arcade/pixel/kinds";
import { storage } from "@/lib/storage";
import { useContainerDims } from "@/lib/viz/hooks";
import type { ArcadeData } from "./data";
import type { GameFactory, PixelGame } from "./game";

export const H = 320;
export const MIN_W = 180;
export const MAX_W = 960;
const STEP = 1000 / 60;

export const bestKey = (id: string) => `arcadeBest:${id}`;

export function loadBest(id: string): number {
  const n = storage.get<unknown>(bestKey(id));
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

export function PixelScreen({
  id,
  factory,
  data,
  fit = true,
  onExit,
}: {
  id: string;
  factory: GameFactory;
  data: ArcadeData;
  fit?: boolean;
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
    const initialW = fit ? Math.round(clamp(Math.floor(box.clientWidth / scale), MIN_W, MAX_W)) : MIN_W;
    canvas.width = initialW;
    canvas.height = H;
    setGameW(initialW);

    let best = loadBest(id);
    const game = factory({ canvas, width: initialW, height: H, data, best });
    gameRef.current = game;

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let wasHidden = document.hidden;

    const onVisibility = () => {
      wasHidden = true;
      acc = 0;
    };
    document.addEventListener("visibilitychange", onVisibility);

    const frame = (now: number) => {
      if (document.hidden) {
        wasHidden = true;
        acc = 0;
        raf = requestAnimationFrame(frame);
        return;
      }
      if (wasHidden) {
        wasHidden = false;
        last = now;
        acc = 0;
      }
      acc += Math.min(100, now - last);
      last = now;
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
      if (el && el.closest("button,a,[role='button'],[role='menuitem']")) return;
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
      document.removeEventListener("visibilitychange", onVisibility);
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
    setGameW(nextW);
    game.resize(nextW, H);
    game.render();
  }, [width, height, fit]);

  const toGame = (e: React.PointerEvent): [number, number] => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * H];
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
      <canvas
        ref={canvasRef}
        className="block touch-none"
        style={{ width: gameW * k, height: H * k, imageRendering: "pixelated" }}
        aria-label="Arcade game"
      />
    </div>
  );
}
