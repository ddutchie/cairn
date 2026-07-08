import type { ReactNode } from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import Constants from "expo-constants";
import { useTheme, type as typeScale, type Theme } from "@/theme";

const APP_VERSION = Constants.expoConfig?.version ?? "";
// Same artwork as the launch splash, so empty states read as "the app, waiting
// for content" rather than a bare error.
const CAIRN_ICON = require("../../assets/splashIcon.png");

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
}: {
  title?: string;
  subtitle?: string;
  /** Custom body below the brand block (overrides title/subtitle if provided). */
  children?: ReactNode;
  /** Smaller icon + tighter spacing, for overlays over a list. */
  compact?: boolean;
  /** "center" (default) fills and centres; "top" biases the content toward the
   *  upper ~22% so it stays readable when a keyboard covers the lower half. */
  align?: "center" | "top";
}) {
  const t = useTheme();
  const styles = makeStyles(t);
  const iconSize = compact ? 56 : 76;

  return (
    <View style={[styles.root, align === "top" && styles.rootTop]}>
      <View style={styles.brand}>
        <Image source={CAIRN_ICON} style={{ width: iconSize, height: iconSize }} resizeMode="contain" />
        <Text style={styles.wordmark}>Cairn</Text>
        {APP_VERSION ? <Text style={styles.version}>v{APP_VERSION}</Text> : null}
      </View>

      {children ?? (
        <View style={styles.content}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
      )}
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
  });
}
