import type { HingeStatus } from "@expo/ui/swift-ui/modifiers";

/** The shape of an expo-hinge reading (kept structural so this file has no runtime imports). */
export interface HingeReading {
  angle: number;
  status: HingeStatus;
}

/** Below this angle (degrees, 0 = closed, 180 = flat) a foldable counts as closed on Android. */
export const ANDROID_CLOSED_ANGLE = 15;

/**
 * Our status for an expo-hinge reading. iOS reports `closed` itself; Android never does (it
 * reports `unknown` when the window doesn't span the fold, e.g. a closed device's outer
 * screen), so a near-zero angle there means closed.
 */
export function statusFromHinge(hinge: HingeReading | null, os: string): HingeStatus | null {
  if (!hinge) return null;
  if (os === "android" && hinge.status !== "closed" && hinge.angle < ANDROID_CLOSED_ANGLE) return "closed";
  return hinge.status;
}
