import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";

// Cache the availability check (it's a native call; result is stable per launch).
// isGlassEffectAPIAvailable guards against iOS-26-beta crashes (Expo issue
// #40911); isLiquidGlassAvailable confirms the Liquid Glass design is active.
const GLASS_OK = (() => {
  try {
    return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

/**
 * A bar container that renders iOS 26 Liquid Glass when available, and falls
 * back to a solid themed surface elsewhere (older iOS, Android, reduce-
 * transparency). Used for the chat composer + search input to feel native.
 */
export function GlassBar({
  children,
  style,
  interactive = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
}) {
  if (GLASS_OK) {
    return (
      <GlassView style={style} glassEffectStyle="regular" isInteractive={interactive}>
        {children}
      </GlassView>
    );
  }
  // Fallback: plain View — the caller's `style` carries the fallback bg/border
  // (see chat/search styles that key off `glassActive`).
  return <View style={style}>{children}</View>;
}

/** Whether the Liquid Glass effect is active (for callers to tweak child styling). */
export const glassActive = GLASS_OK;
