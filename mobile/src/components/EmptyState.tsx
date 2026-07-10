import { useRef, useState, type ReactNode } from "react";
import { View, Text, Image, Pressable, StyleSheet } from "react-native";
import Constants from "expo-constants";
import { BreakoutGame } from "@/components/BreakoutGame";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

const APP_VERSION = Constants.expoConfig?.version ?? "";
// Same artwork as the launch splash, so empty states read as "the app, waiting
// for content" rather than a bare error.
const CAIRN_ICON = require("../../assets/splashIcon.png");

// Easter egg: tap the icon this many times within the window to launch Breakout.
const EGG_TAPS = 5;
const EGG_WINDOW_MS = 3000;

/**
 * Shared empty-state scaffold used across tabs (Search, Projects, Graph, …).
 *
 * Renders the Cairn splash icon + wordmark + version at the top, then either a
 * `title`/`subtitle` pair or arbitrary `children` below. Centres itself in the
 * available space by default. Keeps every empty state visually consistent and
 * on-brand.
 *
 *   [icon]
 *   Cairn
 *   v0.1.1
 *
 *   Title
 *   Subtitle / content
 */
export function EmptyState({
  title,
  subtitle,
  children,
  compact = false,
  align = "center",
  topBias,
}: {
  title?: string;
  subtitle?: string;
  /** Optional action(s) rendered below the title/subtitle (e.g. a button). */
  children?: ReactNode;
  /** Smaller icon + tighter spacing, for overlays over a list. */
  compact?: boolean;
  /** "center" (default) fills and centres; "top" biases the content toward the
   *  upper third so it stays readable when a keyboard covers the lower half. */
  align?: "center" | "top";
  /** Overrides the `align="top"` bias (default "25%"). Pass an absolute px value
   *  when the container height can't be trusted (e.g. an iOS 27 search list
   *  whose frame isn't the full screen) so the content lands at a screen-top-
   *  relative position that matches other screens. */
  topBias?: number | `${number}%`;
}) {
  const t = useTheme();
  const styles = makeStyles(t);
  const iconSize = compact ? 56 : 76;

  // Easter egg: 5 quick taps on the Cairn icon launches Breakout.
  const [gameOpen, setGameOpen] = useState(false);
  const tapTimes = useRef<number[]>([]);
  const onIconTap = () => {
    const now = Date.now();
    tapTimes.current = [...tapTimes.current, now].filter((ts) => now - ts <= EGG_WINDOW_MS);
    if (tapTimes.current.length >= EGG_TAPS) {
      tapTimes.current = [];
      haptics.success(); // celebratory buzz as the game reveals
      setGameOpen(true);
    }
  };

  return (
    <View
      style={[
        styles.root,
        align === "top" && styles.rootTop,
        // Override the default "25%" bias when a caller needs an exact position
        // (e.g. iOS 27 search list — see topBias doc).
        align === "top" && topBias != null ? { paddingTop: topBias } : null,
      ]}
    >
      <View style={styles.brand}>
        <Pressable onPress={onIconTap} accessibilityLabel="Cairn">
          <Image source={CAIRN_ICON} style={{ width: iconSize, height: iconSize }} resizeMode="contain" />
        </Pressable>
        <Text style={styles.wordmark}>Cairn</Text>
        {APP_VERSION ? <Text style={styles.version}>v{APP_VERSION}</Text> : null}
      </View>

      <View style={styles.content}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {children ? <View style={styles.action}>{children}</View> : null}
      </View>

      <BreakoutGame visible={gameOpen} onClose={() => setGameOpen(false)} />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
    // Bias toward the top (~25% down) instead of centring, so the icon + text
    // sit above where a keyboard would cover.
    rootTop: { justifyContent: "flex-start", paddingTop: "25%" },
    brand: { alignItems: "center", marginBottom: 20 },
    wordmark: { ...typeScale.heading, color: t.textPrimary, marginTop: 10 },
    version: { ...typeScale.caption, color: t.textTertiary, marginTop: 2, fontVariant: ["tabular-nums"] },
    content: { alignItems: "center", maxWidth: 320 },
    title: { ...typeScale.title, color: t.textSecondary, textAlign: "center" },
    subtitle: { ...typeScale.caption, color: t.textTertiary, textAlign: "center", marginTop: 8, lineHeight: 20 },
    action: { marginTop: 16, alignItems: "center" },
  });
}
