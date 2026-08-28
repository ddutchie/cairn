import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useDerivedValue, type SharedValue } from "react-native-reanimated";
import { COMPOSER, GRID, GUTTER, MENU, MENU_HEIGHT, mix, PLUS_CENTER_X } from "./constants";
import { PanelMaterial } from "./glass";

export interface PanelDrivers {
  open: SharedValue<number>;
  morph: SharedValue<number>;
  menuOpacity: SharedValue<number>;
  gridOpacity: SharedValue<number>;
  blur: SharedValue<number>;
  composerBottom: SharedValue<number>;
}

export function AttachmentPanel({
  screenHeight,
  gridWidth,
  gridHeight,
  interactive,
  glass,
  glassDuration,
  menu,
  grid,
  open,
  morph,
  menuOpacity,
  gridOpacity,
  blur,
  composerBottom,
}: PanelDrivers & {
  screenHeight: number;
  gridWidth: number;
  gridHeight: number;
  interactive: "menu" | "grid" | "none";
  glass: boolean;
  glassDuration: number;
  menu: ReactNode;
  grid: ReactNode;
}) {
  const rect = useDerivedValue(() => {
    const bottom = composerBottom.get();
    const plusCenter = bottom - COMPOSER.rowHeight / 2;
    const top = plusCenter + MENU.centerOffset - MENU_HEIGHT / 2;
    const m = morph.get();
    let x = GUTTER;
    let y = top;
    let w = mix(m, MENU.width, gridWidth);
    let h = mix(m, MENU_HEIGHT, screenHeight - top - GUTTER);
    let r = mix(m, MENU.radius, GRID.panelRadius);
    const o = open.get();
    const well = COMPOSER.plusWell;
    x = mix(o, PLUS_CENTER_X - well / 2, x);
    y = mix(o, plusCenter - well / 2, y);
    w = mix(o, well, w);
    h = mix(o, well, h);
    r = mix(o, well / 2, r);
    return { x, y, w, h, r };
  });

  const openFade = useDerivedValue(() => interpolate(open.get(), [0.12, 0.6], [0, 1], Extrapolation.CLAMP));

  const panelStyle = useAnimatedStyle(() => {
    const { x, y, w, h } = rect.get();
    return { left: x, top: y, width: w, height: h };
  });

  const shapeStyle = useAnimatedStyle(() => ({ borderRadius: rect.get().r }));

  const menuStyle = useAnimatedStyle(() => ({
    opacity: menuOpacity.get() * openFade.get(),
    transform: [{ scale: rect.get().w / MENU.width }],
  }));

  const gridStyle = useAnimatedStyle(() => ({
    opacity: gridOpacity.get() * openFade.get(),
    transform: [{ scale: rect.get().w / gridWidth }],
  }));

  const blurStyle = useAnimatedStyle(() => ({ opacity: blur.get() * 0.85 * openFade.get() }));

  return (
    <Animated.View pointerEvents="box-none" style={[styles.panel, panelStyle]}>
      <PanelMaterial variant={glass ? "regular" : "none"} duration={glassDuration} style={[StyleSheet.absoluteFill, shapeStyle]} />
      <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.clip, shapeStyle]}>
        <Animated.View pointerEvents={interactive === "grid" ? "auto" : "none"} style={[styles.content, { width: gridWidth, height: gridHeight }, gridStyle]}>
          {grid}
        </Animated.View>
        <Animated.View pointerEvents={interactive === "menu" ? "auto" : "none"} style={[styles.content, { width: MENU.width, height: MENU_HEIGHT }, menuStyle]}>
          {menu}
        </Animated.View>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, blurStyle]}>
          <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: { position: "absolute" },
  clip: { overflow: "hidden", borderCurve: "continuous" },
  content: { position: "absolute", left: 0, top: 0 },
});
