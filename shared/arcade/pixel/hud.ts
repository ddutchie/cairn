/**
 * Where a pixel game's HUD must stay clear of, in game pixels: safe-area
 * insets and rounded display corners on mobile, or `NO_HUD` on desktop.
 */
export interface PixelHud {
  top: number;
  bottom: number;
  left: number;
  right: number;
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

export const NO_HUD: PixelHud = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  topLeft: 0,
  topRight: 0,
  bottomLeft: 0,
  bottomRight: 0,
};

export type InputMode = "touch" | "pointer";
