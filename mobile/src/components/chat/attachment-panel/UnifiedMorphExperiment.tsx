/**
 * Experiment: popup as part of the input — the composer Glass itself morphs into the sheet.
 * Instead of an OverKeyboardView overlay, the menu/grid lives INSIDE the composer's Glass,
 * so the surface is continuous: plusWell circle → menu (280×222) → grid (full width × ~60% height).
 *
 * Toggle with `enabled` prop in ChatScreen to compare vs the overlay host.
 * This is a quick spike — not yet wired to file-attachments, just the morph + theming.
 */
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { Camera, Images, Paperclip } from "lucide-react-native";
import { useTheme, withAlpha } from "@/theme";
import { Glass, LIQUID_GLASS } from "./glass";
import { COMPOSER, GUTTER, MENU, MENU_HEIGHT, GRID, SPRING, DURATION, EASE_FADE, mix } from "./constants";

const MENU_W = MENU.width; // 280
const MENU_H = MENU_HEIGHT; // 222 (3 items)
type Mode = "closed" | "menu" | "grid";

export function UnifiedMorphExperiment() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const isLight = t.background === "#f5f4f1";
  const [mode, setMode] = useState<Mode>("closed");
  const open = useSharedValue(0);
  const morph = useSharedValue(0);
  const menuOpacity = useSharedValue(0);
  const gridOpacity = useSharedValue(0);

  const gridW = width - GUTTER * 2;
  const gridH = 380;

  const toggleMenu = useCallback(() => {
    if (mode === "closed") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setMode("menu");
      open.set(withSpring(1, SPRING.panel));
      menuOpacity.set(withTiming(1, { duration: DURATION.crossfade, easing: EASE_FADE }));
      morph.set(0);
      gridOpacity.set(0);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      open.set(withSpring(0, SPRING.panelOut, (fin) => {
        if (fin) {
          // reset on UI thread? use runOnJS
        }
      }));
      menuOpacity.set(withTiming(0, { duration: DURATION.crossfade, easing: EASE_FADE }));
      gridOpacity.set(withTiming(0, { duration: DURATION.crossfade, easing: EASE_FADE }));
      morph.set(withTiming(0, { duration: DURATION.crossfade }));
      setTimeout(() => setMode("closed"), 350);
    }
  }, [mode, open, menuOpacity, morph, gridOpacity]);

  const showGrid = useCallback(() => {
    setMode("grid");
    morph.set(withSpring(1, SPRING.panel));
    menuOpacity.set(withTiming(0, { duration: DURATION.crossfade }));
    gridOpacity.set(withTiming(1, { duration: DURATION.crossfade }));
  }, [morph, menuOpacity, gridOpacity]);

  const backToMenu = useCallback(() => {
    setMode("menu");
    morph.set(withSpring(0, SPRING.panel));
    menuOpacity.set(withTiming(1, { duration: DURATION.crossfade }));
    gridOpacity.set(withTiming(0, { duration: DURATION.crossfade }));
  }, [morph, menuOpacity, gridOpacity]);

  // Container rect: closed = plusWell circle at left of composer, open = menu/grid sheet
  const rect = useDerivedValue(() => {
    const o = open.get();
    const m = morph.get();
    // Closed: 34 circle at PLUS_CENTER_X
    const well = COMPOSER.plusWell; // 34
    const plusCX = GUTTER + COMPOSER.rowPaddingLeft + COMPOSER.plusHit / 2;
    // Open menu vs grid dimensions
    const targetW = m > 0.5 ? gridW : MENU_W;
    const targetH = m > 0.5 ? gridH : MENU_H;
    const targetR = m > 0.5 ? GRID.panelRadius : MENU.radius;
    const targetX = m > 0.5 ? GUTTER : GUTTER + 12; // grid full bleed with gutter, menu inset a bit
    const targetY = -targetH - 12; // above composer row (composer sits at bottom, so negative)
    // Mix closed → target
    let w = mix(o, well, mix(m, MENU_W, gridW));
    let h = mix(o, well, mix(m, MENU_H, gridH));
    let r = mix(o, well / 2, mix(m, MENU.radius, GRID.panelRadius));
    let x = mix(o, plusCX - well / 2, targetX);
    let y = mix(o, -well / 2 - COMPOSER.rowHeight / 2, targetY);
    // When closed, container is the composer row itself (so morph looks like plus expanding)
    // For demo we keep composer row always visible and animate an overlay above it
    // Here we animate the overlay rect separately for clarity
    return { x, y, w, h, r };
  });

  const containerStyle = useAnimatedStyle(() => {
    const { x, y, w, h } = rect.get();
    return { left: x, top: y, width: w, height: h, borderRadius: rect.get().r, opacity: open.get() === 0 ? 0 : 1 };
  });

  const menuStyle = useAnimatedStyle(() => ({
    opacity: menuOpacity.get() * interpolate(open.get(), [0.2, 0.6], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: rect.get().w / MENU_W }],
  }));
  const gridStyle = useAnimatedStyle(() => ({
    opacity: gridOpacity.get() * interpolate(open.get(), [0.2, 0.6], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: rect.get().w / gridW }],
  }));

  const wellBg = LIQUID_GLASS && isLight ? withAlpha(t.textPrimary, 0.08) : "rgba(255,255,255,0.09)";
  const iconColor = LIQUID_GLASS && isLight ? t.textPrimary : "#FFFFFF";
  const labelColor = LIQUID_GLASS && isLight ? t.textPrimary : "#FFFFFF";

  return (
    <View style={styles.demoWrap}>
      <Text style={[styles.caption, { color: t.textSecondary }]}>Unified morph — panel lives inside composer Glass</Text>

      {/* Composer mock — the real composer row */}
      <Glass radius={COMPOSER.radius} fallbackTint={withAlpha(t.surface2, 0.92)} style={styles.composerMock}>
        <View style={styles.row}>
          <Pressable onPress={toggleMenu} style={styles.plusHit}>
            <Text style={{ color: t.textSecondary, fontWeight: "700" }}>{mode === "closed" ? "+" : "×"}</Text>
          </Pressable>
          <View style={[styles.fakeInput, { backgroundColor: withAlpha(t.textTertiary, 0.12) }]}>
            <Text style={{ color: t.textTertiary, fontSize: 14 }}>Message Cairn…</Text>
          </View>
          <View style={[styles.sendMock, { backgroundColor: t.accent }]} />
        </View>
      </Glass>

      {/* Morphing overlay — same Glass surface, continuous */}
      <Animated.View pointerEvents={mode === "closed" ? "none" : "box-none"} style={[styles.overlay, containerStyle]}>
        <Glass radius={rect.get().r} style={StyleSheet.absoluteFill} fallbackTint={isLight ? "rgba(255,255,255,0.9)" : "rgba(30,30,30,0.9)"} />
        <View style={styles.clip}>
          <Animated.View pointerEvents={mode === "menu" ? "auto" : "none"} style={[styles.content, { width: MENU_W, height: MENU_H }, menuStyle]}>
            {[
              { label: "Camera", Icon: Camera },
              { label: "Photos", Icon: Images },
              { label: "Files", Icon: Paperclip },
            ].map((it) => (
              <Pressable key={it.label} onPress={it.label === "Photos" ? showGrid : undefined} style={styles.menuRow}>
                <View style={[styles.well, { backgroundColor: wellBg }]}>
                  <it.Icon size={22} color={iconColor} />
                </View>
                <Text style={[styles.menuLabel, { color: labelColor }]}>{it.label}</Text>
              </Pressable>
            ))}
          </Animated.View>
          <Animated.View pointerEvents={mode === "grid" ? "auto" : "none"} style={[styles.content, { width: gridW, height: gridH }, gridStyle]}>
            <View style={styles.gridMock}>
              {Array.from({ length: 9 }).map((_, i) => (
                <View key={i} style={[styles.cell, { backgroundColor: withAlpha(t.accent, 0.15 + (i % 3) * 0.1) }]} />
              ))}
            </View>
            <Pressable onPress={backToMenu} style={styles.backBtn}>
              <Text style={{ color: t.accent }}>‹ Back</Text>
            </Pressable>
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  demoWrap: { height: 520, justifyContent: "flex-end", paddingBottom: 12, gap: 12 },
  caption: { fontSize: 12, textAlign: "center", opacity: 0.7 },
  composerMock: { marginHorizontal: GUTTER, paddingVertical: 6, paddingHorizontal: 8, flexDirection: "row", overflow: "hidden" },
  row: { height: COMPOSER.rowHeight, flexDirection: "row", alignItems: "center", gap: 10, flex: 1, paddingLeft: COMPOSER.rowPaddingLeft },
  plusHit: { width: COMPOSER.plusHit, height: COMPOSER.plusHit, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  fakeInput: { flex: 1, height: 32, borderRadius: 16, justifyContent: "center", paddingHorizontal: 12 },
  sendMock: { width: 32, height: 32, borderRadius: 12 },
  overlay: { position: "absolute", overflow: "hidden" },
  clip: { flex: 1, overflow: "hidden", borderCurve: "continuous" as const },
  content: { position: "absolute", left: 0, top: 0 },
  menuRow: { height: MENU.itemHeight, flexDirection: "row", alignItems: "center", paddingLeft: MENU.iconInset },
  well: { width: MENU.iconWell, height: MENU.iconWell, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  menuLabel: { marginLeft: MENU.labelGap, fontSize: MENU.labelSize, fontWeight: "500" },
  gridMock: { flexDirection: "row", flexWrap: "wrap", gap: 4, padding: 12, paddingTop: 16 },
  cell: { width: "31%", aspectRatio: 1, borderRadius: 8 },
  backBtn: { position: "absolute", left: 12, bottom: 12, padding: 8 },
});
