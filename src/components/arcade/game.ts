/**
 * The contract between a desktop arcade game adapter and `PixelScreen`.
 * All game logic lives in @cairn/shared/arcade/*.
 */

import type { ArcadeGameId } from "@cairn/shared/arcade/menu";
import type { ArcadeData } from "./data";

export type { ArcadeGameId };

export interface PixelGame {
  update(): void;
  render(): void;
  /** Pointer pressed / moved / released, in game pixels. */
  down(x: number, y: number): void;
  move(x: number, y: number): void;
  up(): void;
  /** A key went down or up; returns true when the game used it. */
  key(code: string, down: boolean): boolean;
  /** Optional hook when the host canvas width changes mid-run. */
  resize?(width: number, height: number): void;
  /** Called when the host tears the game down (stop listening to the store, timers). */
  dispose?(): void;
  /** Best score so far (the host persists it when it rises). */
  readonly best: number;
}

export interface GameEnv {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  data: ArcadeData;
  best: number;
}

export type GameFactory = (env: GameEnv) => PixelGame;
