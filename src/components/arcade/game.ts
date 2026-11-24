/**
 * The contract between an arcade game and its host (`PixelScreen`). The host
 * binds the canvas, steps `update` at 60 Hz, calls `render` every frame and
 * forwards input in game pixels.
 */

import type { ArcadeData } from "./data";

export type ArcadeGameId = "task-force" | "stacker" | "breakout" | "wayfinder" | "inbox-zero";

export interface PixelGame {
  update(): void;
  render(): void;
  /** Pointer pressed / moved / released, in game pixels. */
  down(x: number, y: number): void;
  move(x: number, y: number): void;
  up(): void;
  /** A key went down or up; returns true when the game used it. */
  key(code: string, down: boolean): boolean;
  /** Optional hook when the host canvas width changes mid-run (live `W` already updated). */
  resize?(prevW: number): void;
  /** Best score so far (the host persists it when it rises). */
  readonly best: number;
}

export interface GameEnv {
  data: ArcadeData;
  best: number;
}

export type GameFactory = (env: GameEnv) => PixelGame;
