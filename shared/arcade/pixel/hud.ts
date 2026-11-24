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

/** A HUD row's usable span: text starts at `lx`, ends by `rx`. */
export interface HudRow {
  /** Top of a row pinned to the top edge; for `bottom`, the lowest y a row may reach. */
  y: number;
  lx: number;
  rx: number;
  cx: number;
}

/** Where a game places its HUD; see `hudFrame`. */
export interface HudFrame {
  /** A row hugging the top edge: below the safe top, sides clear of the rounded top corners. */
  top: HudRow;
  /** A row hugging the bottom edge: above the safe bottom, sides clear of the rounded bottom corners. */
  bottom: HudRow;
  /** Anything between the two: clear of the side insets (notch, the Duo's side rail). */
  content: HudRow;
}

/** Breathing room between a HUD edge and its text, in game pixels. */
export const HUD_PAD = 4;

/**
 * The one place a pixel game turns its safe-area insets into HUD positions, so
 * every game clears the rounded corners the same way (rows that hug the top or
 * bottom edge need `topLeft`/`topRight`/`bottomLeft`/`bottomRight`, not just
 * `left`/`right`: with the iPhone Duo unfolded the top inset is tiny and the
 * curve is all that keeps text off the glass). With `NO_HUD` it is a plain
 * 4px margin.
 */
export function hudFrame(hud: PixelHud, W: number, H: number): HudFrame {
  const row = (y: number, l: number, r: number): HudRow => {
    const lx = l + HUD_PAD, rx = W - r - HUD_PAD;
    return { y, lx, rx, cx: Math.round((lx + rx) / 2) };
  };
  return {
    top: row(hud.top + HUD_PAD, hud.topLeft, hud.topRight),
    bottom: row(H - hud.bottom - HUD_PAD, hud.bottomLeft, hud.bottomRight),
    content: row(hud.top + HUD_PAD, hud.left, hud.right),
  };
}
