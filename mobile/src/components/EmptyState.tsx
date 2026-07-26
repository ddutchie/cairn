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
  pinned = false,
  insetTop = 0,
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
  /** Overrides the top bias (default "25%"). For `pinned`, a percentage is
   *  measured against the FULL SCREEN height (the overlay fills the screen), so
   *  the icon lands at a stable screen-relative position on every tab. */
  topBias?: number | `${number}%`;
  /** Render as a screen-pinned absolute overlay (position:absolute, fills the
   *  parent) INSTEAD of a flex child. Use this when the empty state would
   *  otherwise live inside a scroll/list container whose keyboard-driven content
   *  inset makes the placeholder jump around. As a sibling of the scroll view it
   *  stays put regardless of keyboard/inset changes. Implies `align="top"`.
   *  `pointerEvents` is "none" so it never blocks the list beneath it. */
  pinned?: boolean;
  /** For `pinned`: top offset (px) so the overlay clears a native header/search
   *  bar (e.g. `insets.top`). The topBias is applied ON TOP of this. */
  insetTop?: number;
}) {
  const t = useTheme();
  const styles = makeStyles(t);
  const iconSize = compact ? 56 : 76;
  // Pinned overlays are always top-biased (an absolute fill can't "centre" over
  // a keyboard sensibly); default the bias to 25% of the screen when unset.
  const effectiveAlign = pinned ? "top" : align;
  const effectiveBias = pinned ? topBias ?? "25%" : topBias;

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
      // Pinned overlays sit ABOVE the scroll/list content but must never
      // intercept touches (pull-to-refresh, scroll-to-focus the search bar).
      pointerEvents={pinned ? "none" : "auto"}
      style={[
        styles.root,
        // As a screen-pinned overlay: absolutely fill the parent so the anchor is
        // the (stable) parent frame, not a keyboard-inset-shifted scroll box.
        pinned && styles.rootPinned,
        effectiveAlign === "top" && styles.rootTop,
        // insetTop clears a native header/search bar; the bias below stacks on
        // top of it as a spacer, so the two never fight over `paddingTop`.
        effectiveAlign === "top" && insetTop ? { paddingTop: insetTop } : null,
      ]}
    >
      {/* Top spacer supplies the bias (px or %) that pushes the icon down to a
          stable position. A percentage resolves against the parent frame — the
          full screen for a pinned overlay — so it can't jump with keyboard
          insets. Defaults to 25% for any top-aligned state. */}
      {effectiveAlign === "top" ? (
        <View style={{ height: effectiveBias ?? "25%" }} />
      ) : null}
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
    // Bias toward the top instead of centring, so the icon + text sit above
    // where a keyboard would cover. The actual offset is a spacer View (see
    // render) so px/% work identically and a % resolves against the parent frame.
    rootTop: { justifyContent: "flex-start" },
    // Screen-pinned overlay: fills the parent (a tab body) absolutely so the
    // empty state is a SIBLING of — not a child inside — the scroll/list. That
    // decouples it from the container's keyboard-driven content inset, so it no
    // longer jumps when the keyboard opens. Behind everything else it overlays.
    rootPinned: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    brand: { alignItems: "center", marginBottom: 20 },
    wordmark: { ...typeScale.heading, color: t.textPrimary, marginTop: 10 },
    version: { ...typeScale.caption, color: t.textTertiary, marginTop: 2, fontVariant: ["tabular-nums"] },
    content: { alignItems: "center", maxWidth: 320 },
    title: { ...typeScale.title, color: t.textSecondary, textAlign: "center" },
    subtitle: { ...typeScale.caption, color: t.textTertiary, textAlign: "center", marginTop: 8, lineHeight: 20 },
    action: { marginTop: 16, alignItems: "center" },
  });
}
