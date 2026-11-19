/**
 * The hidden "preview features" unlock: tap the app version line in Settings
 * seven times (each within a couple of seconds of the last) to reveal the People
 * switch in a release build. Same rule on desktop and mobile; pure so both test
 * it. Whether a device is unlocked is stored locally and never synced.
 */

export const UNLOCK_TAPS = 7;
/** A pause longer than this starts the count over. */
export const UNLOCK_GAP_MS = 2000;

export interface UnlockTapState {
  count: number;
  /** When the previous tap happened (ms). */
  at: number;
}

export const FRESH_TAPS: UnlockTapState = { count: 0, at: 0 };

/** Register one tap at `now`. `unlocked` is true on the tap that reaches the threshold. */
export function registerUnlockTap(state: UnlockTapState, now: number): { state: UnlockTapState; unlocked: boolean } {
  const count = state.count > 0 && now - state.at <= UNLOCK_GAP_MS ? state.count + 1 : 1;
  if (count >= UNLOCK_TAPS) return { state: FRESH_TAPS, unlocked: true };
  return { state: { count, at: now }, unlocked: false };
}

/**
 * Whether the People switch shows in Settings: always in development builds,
 * once this device unlocked preview features, and whenever the flag is already
 * on (so it can be turned off again). Release users otherwise see nothing.
 */
export function showPeopleSwitch(opts: { dev: boolean; unlocked: boolean; flagOn: boolean }): boolean {
  return opts.dev || opts.unlocked || opts.flagOn;
}
