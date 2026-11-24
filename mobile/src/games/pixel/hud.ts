import type { CornerSafeInsets } from "@/lib/screen-corners";
import type { PixelHud } from "@cairn/shared/arcade/pixel/hud";

export { NO_HUD, type PixelHud } from "@cairn/shared/arcade/pixel/hud";

/** Convert display corner safe insets in dp to game-pixel HUD clearance at scale `k`. */
export function hudFromInsets(s: CornerSafeInsets, k: number): PixelHud {
  const px = (n: number) => Math.ceil(n / Math.max(1, k));
  return {
    top: px(s.top),
    bottom: px(s.bottom),
    left: px(s.left),
    right: px(s.right),
    topLeft: px(s.topLeft),
    topRight: px(s.topRight),
    bottomLeft: px(s.bottomLeft),
    bottomRight: px(s.bottomRight),
  };
}
