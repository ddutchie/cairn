import { Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHingeStatus } from "@/lib/hinge";

/**
 * The window width at which Cairn switches from its single-column phone layout to
 * wide layouts (side preview, split view, title-less tabs, rail toolbars).
 *
 * One value for every wide/compact decision, JS and native (`forceCompactBelow`),
 * so a window never counts as wide for one screen and compact for another. The
 * unfolded iPhone Duo is phone idiom and so has no regular size class to key on;
 * its ~669pt portrait inner window is deliberately below this, ~951pt landscape
 * above it.
 */
export const WIDE_MIN_WIDTH = 700;

/**
 * True when the iOS side rail is in its height-constrained posture — the
 * folded iPhone Duo in landscape (~466pt tall). The 5-tab pill occupies most
 * of the vertical rail, leaving room for only one button pill above it
 * (portrait is ~678pt tall and fits three). Screens and columns with more
 * than one rail item collapse them into a single `•••` overflow menu here.
 */
export function useTightSideRail(): boolean {
  const { width, height } = useWindowDimensions();
  const { left, right } = useSafeAreaInsets();
  const hingeClosed = useHingeStatus() === "closed";
  if (Platform.OS !== "ios" || Platform.isPad) return false;
  const compact = width < WIDE_MIN_WIDTH || hingeClosed;
  return compact && (left > 0 || right > 0) && width > height;
}
