import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { useIsFocused } from "expo-router";
import { useReducedMotion } from "react-native-reanimated";
import { durationScale, scaleDuration } from "./motion";

export interface Motion {
  /** True when the OS asks for reduced motion. Skip decorative movement; set values instantly. */
  reduced: boolean;
  /** 1 normally, 0 under reduce motion. Multiply a duration by it, or use `ms`. */
  scale: number;
  /** A duration in ms after the reduce-motion scale (0 when reduced). */
  ms: (duration: number) => number;
}

/**
 * The one gate for decorative motion. Wraps Reanimated's `useReducedMotion` and hands back a
 * duration scale, so a component writes `withTiming(v, { duration: motion.ms(300) })` and
 * reduce motion collapses it to an instant set without its own branch.
 *
 * Checklist for any animated component (adapted from Reacticx or written here):
 *  1. Colours come from `useTheme()` tokens (`withAlpha` for alpha), never hex/rgba.
 *  2. Text uses the `type` scale (rem-style, follows the font-size setting), never raw pixels.
 *  3. Any new gesture has an `accessibilityLabel` and a non-gesture path.
 *  4. Looping animation pauses when the screen blurs (`useScreenActive`) and on unmount.
 *  5. Reduce motion sets values instantly or shows a static state; nothing loops.
 *  6. No new width breakpoints; size to the pane, and keep clear of the fold (`useFold`).
 */
export function useMotion(): Motion {
  const reduced = useReducedMotion();
  return { reduced, scale: durationScale(reduced), ms: (d) => scaleDuration(d, reduced) };
}

/** True while VoiceOver / TalkBack is running. Text that cycles must never animate under it. */
export function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled().then((v) => alive && setOn(v)).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

/** True while this screen is focused. Gate looping animation on it so blurred tabs stay idle. */
export function useScreenActive(): boolean {
  return useIsFocused();
}
