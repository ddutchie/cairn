import { describe, it, expect } from "vitest";
import { statusFromHinge } from "./hinge-status";

describe("statusFromHinge", () => {
  it("passes iOS readings through", () => {
    expect(statusFromHinge({ angle: 0, status: "closed" }, "ios")).toBe("closed");
    expect(statusFromHinge({ angle: 120, status: "partiallyOpen" }, "ios")).toBe("partiallyOpen");
    // iOS never infers closed from the angle.
    expect(statusFromHinge({ angle: 3, status: "unknown" }, "ios")).toBe("unknown");
  });

  it("derives closed from a near-zero angle on Android (it never reports closed)", () => {
    expect(statusFromHinge({ angle: 2, status: "unknown" }, "android")).toBe("closed");
    expect(statusFromHinge({ angle: 14, status: "unknown" }, "android")).toBe("closed");
  });

  it("keeps Android's own status above the threshold", () => {
    expect(statusFromHinge({ angle: 90, status: "partiallyOpen" }, "android")).toBe("partiallyOpen");
    expect(statusFromHinge({ angle: 180, status: "fullyOpen" }, "android")).toBe("fullyOpen");
    expect(statusFromHinge({ angle: 40, status: "unknown" }, "android")).toBe("unknown");
  });

  it("returns null without a reading", () => {
    expect(statusFromHinge(null, "android")).toBeNull();
    expect(statusFromHinge(null, "ios")).toBeNull();
  });
});
