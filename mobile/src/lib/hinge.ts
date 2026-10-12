import type { HingeStatus } from "@expo/ui/swift-ui/modifiers";

/**
 * Last hinge status any view observed (iPhone Duo). `onHingeChange` only reports
 * once a view appears, so a freshly mounted column would lay out one frame
 * without knowing about the fold; seeding its state from here avoids that jump.
 */
let last: HingeStatus | null = null;

export function lastHingeStatus(): HingeStatus | null {
  return last;
}

export function rememberHingeStatus(status: HingeStatus | null): HingeStatus | null {
  last = status;
  return status;
}
