import { useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cornerSafeInsets, type CornerSafeInsets } from "@/lib/screen-corners";

/** Safe-area insets that also clear the rounded display corners (see `cornerSafeInsets`). */
export function useCornerSafeInsets(opts: { minEdge?: number; maxBottom?: number } = {}): CornerSafeInsets {
  const { top, right, bottom, left } = useSafeAreaInsets();
  const { minEdge, maxBottom } = opts;
  return useMemo(() => cornerSafeInsets({ top, right, bottom, left }, { minEdge, maxBottom }), [top, right, bottom, left, minEdge, maxBottom]);
}
