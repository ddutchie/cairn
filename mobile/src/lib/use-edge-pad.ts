import { useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Side padding for a full-width page. Next to the iPhone Duo's bar column the system's
 * safe-area inset already provides the margin, so padding on that side shrinks to
 * `EDGE_NEXT_TO_INSET` instead of stacking on top of it; the other side keeps `base`.
 * Spread it after the page's own padding style.
 */
export const EDGE_NEXT_TO_INSET = 10;

export function useEdgePad(base = 18) {
  const { left, right } = useSafeAreaInsets();
  return useMemo(
    () => ({
      paddingLeft: left > 0 ? Math.min(base, EDGE_NEXT_TO_INSET) : base,
      paddingRight: right > 0 ? Math.min(base, EDGE_NEXT_TO_INSET) : base,
    }),
    [left, right, base],
  );
}
