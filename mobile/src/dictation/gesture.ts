/**
 * The mic button's gesture rules, as a pure function so they can be tested without a
 * device. One button, both habits:
 *   - TAP starts listening and keeps going; tap again to stop (good for long dictation).
 *   - HOLD listens only while held; releasing stops.
 *   - SLIDE LEFT past the threshold and release to cancel and discard.
 * Listening starts the moment the press begins, so there is no lag before the first word.
 */

/** Held at least this long counts as hold-to-talk rather than a tap. */
export const HOLD_MS = 350;
/** Horizontal travel (negative = left) at or beyond which a release cancels. */
export const CANCEL_DX = -80;

export type MicMode = "idle" | "toggled";
export type MicAction = "start" | "stop" | "cancel" | "none";

/** A press began while `mode`: from idle it starts listening; while toggled on, the release will stop it. */
export function onPressIn(mode: MicMode): MicAction {
  return mode === "idle" ? "start" : "none";
}

/**
 * A press ended. `startMode` is the mode when the press began; `durationMs` and `dx`
 * describe the press. Returns the new mode and what to do.
 */
export function onPressOut(
  startMode: MicMode,
  durationMs: number,
  dx: number,
): { mode: MicMode; action: MicAction } {
  if (dx <= CANCEL_DX) return { mode: "idle", action: "cancel" };
  if (startMode === "idle") {
    // A quick press is a tap: keep listening until the next tap.
    return durationMs < HOLD_MS ? { mode: "toggled", action: "none" } : { mode: "idle", action: "stop" };
  }
  // The press that began while listening is the "stop" tap, however long it was held.
  return { mode: "idle", action: "stop" };
}
