import { useMemo } from "react";
import * as Haptics from "expo-haptics";

/**
 * Thin, fire-and-forget wrapper around expo-haptics.
 *
 * Every call is non-blocking and swallows errors — haptics are a nicety, never
 * a failure path (e.g. unsupported device, simulator, or the user disabling
 * system haptics). Prefer these semantic helpers over calling expo-haptics
 * directly so intent (not the raw feedback style) reads at the call site, and
 * so we can tune the mapping in one place.
 *
 *   import { haptics } from "@/haptics";
 *   haptics.impact();          // light tap
 *   haptics.success();         // completed an action
 *
 * In components you can also use the `useHaptics()` hook for a stable object.
 */

function fire(run: () => Promise<void>): void {
  // Fire-and-forget: never await, never throw into the caller.
  run().catch(() => {});
}

export const haptics = {
  /** Light impact — subtle confirmation (bounce, toggle, small hit). */
  impact: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** Medium impact — a more noticeable hit (break, drop, commit). */
  impactMedium: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** Heavy impact — a strong hit (collision, big event). */
  impactHeavy: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  /** Rigid impact — crisp, sharp (mechanical taps). */
  rigid: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid)),
  /** Soft impact — cushioned, gentle. */
  soft: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft)),
  /** Selection tick — for moving through discrete options (pickers, segments). */
  selection: () => fire(() => Haptics.selectionAsync()),
  /** Success notification — an operation completed. */
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** Warning notification — caution / recoverable issue. */
  warning: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  /** Error notification — an operation failed. */
  error: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};

export type HapticsApi = typeof haptics;

/**
 * Hook form of {@link haptics}. Returns the same stable, fire-and-forget helper
 * object — handy in components that already destructure hooks.
 *
 *   const h = useHaptics();
 *   <Pressable onPress={() => { h.selection(); onToggle(); }} />
 */
export function useHaptics(): HapticsApi {
  return useMemo(() => haptics, []);
}
