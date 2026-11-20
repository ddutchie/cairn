import { describe, it, expect } from "vitest";
import { isOnScreen, toScreen } from "./focus-pan";

const W = 400, H = 240;

describe("isOnScreen", () => {
  it("is true for a node inside the canvas and false beyond the margin", () => {
    const t = { k: 1, x: 0, y: 0 };
    expect(isOnScreen(t, 200, 120, W, H)).toBe(true);
    expect(isOnScreen(t, 10, 120, W, H)).toBe(false); // under the left edge margin
    expect(isOnScreen(t, 500, 120, W, H)).toBe(false);
  });

  it("follows the transform: a large graph fitted at the minimum zoom can still overflow", () => {
    // Fit bottoms out at k = 0.2, so nodes more than width / 0.2 from the centre stay off-screen.
    const t = { k: 0.2, x: W / 2, y: H / 2 };
    expect(isOnScreen(t, 0, 0, W, H)).toBe(true);
    expect(isOnScreen(t, 3000, 0, W, H)).toBe(false);
    expect(toScreen(t, 3000, 0).x).toBeGreaterThan(W);
  });

  it("re-checks against the current transform, so a pan interrupted halfway is judged where it stopped", () => {
    const node = { x: 1000, y: 0 };
    const start = { k: 1, x: 0, y: 0 };
    const halfway = { k: 1, x: -500, y: 0 }; // an interrupted pan toward x = 1000 stops here
    expect(isOnScreen(start, node.x, node.y, W, H)).toBe(false);
    expect(isOnScreen(halfway, node.x, node.y, W, H)).toBe(false); // still needs its own pan
    expect(isOnScreen(halfway, 300, 0, W, H)).toBe(false); // x = -200 on screen
    expect(isOnScreen({ k: 1, x: -150, y: 100 }, 300, 0, W, H)).toBe(true);
  });
});
