/* eslint-disable react-hooks/set-state-in-effect */
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Platform, StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";
import Animated, { type AnimatedProps } from "react-native-reanimated";
import { COLORS } from "./constants";
import { useIsDark } from "@/theme";

/** True on iOS 26+, where expo-glass-effect renders the real material. */
export const LIQUID_GLASS = (() => {
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

const BLURS_ITS_BACKDROP = Platform.OS !== "android";

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);

export type GlassStyleName = "regular" | "none";

function useGlassStyle(target: GlassStyleName, duration: number) {
  const [style, setStyle] = useState<GlassStyleName>("none");
  useEffect(() => setStyle(target), [target]);
  return { style, animate: true, animationDuration: duration };
}

function shapeOf(radius: number): ViewStyle {
  return { borderRadius: radius, borderCurve: "continuous" as const };
}

export interface GlassProps extends ViewProps {
  fallbackTint?: string;
  radius?: number;
  active?: boolean;
  interactive?: boolean;
  duration?: number;
  children?: ReactNode;
}

export function Glass({
  fallbackTint,
  radius = 0,
  active = true,
  interactive = true,
  duration = 0.25,
  style,
  children,
  ...rest
}: GlassProps) {
  const glassEffectStyle = useGlassStyle(active ? "regular" : "none", duration);
  const isLight = !useIsDark();

  if (!LIQUID_GLASS) {
    // For the composer we want theme-aware glass: light surface -> light blur with subtle tint, dark -> dark
    // Don't add extra alpha — fallbackTint already comes from withAlpha or solid theme token
    return (
      <BlurView
        intensity={isLight ? 40 : 60}
        tint={isLight ? "extraLight" : "dark"}
        style={[shapeOf(radius), styles.clip, style]}
        {...rest}
      >
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: fallbackTint ? fallbackTint : COLORS.controlScrim, opacity: isLight ? 0.85 : 0.9 }]}
        />
        {children}
      </BlurView>
    );
  }

  return (
    <GlassView glassEffectStyle={glassEffectStyle} style={[shapeOf(radius), style]} isInteractive={interactive} {...rest}>
      {children}
    </GlassView>
  );
}

export function PanelMaterial({
  variant,
  duration,
  style,
}: {
  variant: "regular" | "none";
  duration: number;
  style?: AnimatedProps<ViewProps>["style"];
}) {
  const glassEffectStyle = useGlassStyle(variant, duration);

  if (!LIQUID_GLASS) {
    if (variant === "none") return null;
    return (
      <Animated.View pointerEvents="none" style={[styles.clip, style]}>
        {BLURS_ITS_BACKDROP ? (
          <BlurView intensity={70} tint="systemUltraThinMaterialDark" style={StyleSheet.absoluteFill}>
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.fallbackTint]} />
          </BlurView>
        ) : (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.flatMaterial]} />
        )}
      </Animated.View>
    );
  }

  return <AnimatedGlassView glassEffectStyle={glassEffectStyle} isInteractive style={[styles.shape, style]} />;
}

const styles = StyleSheet.create({
  shape: { borderCurve: "continuous" },
  clip: { overflow: "hidden" },
  fallbackTint: { backgroundColor: COLORS.material },
  flatMaterial: { backgroundColor: COLORS.materialFlat },
});
