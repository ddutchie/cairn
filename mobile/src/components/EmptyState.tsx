import { useRef, useState, type ReactNode } from "react";
import { View, Text, Image, Pressable, StyleSheet, Platform, ActionSheetIOS, Alert } from "react-native";
import Constants from "expo-constants";
import { BreakoutGame } from "@/components/BreakoutGame";
import { StackerGame } from "@/components/StackerGame";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

const APP_VERSION = Constants.expoConfig?.version ?? "";
// Same artwork as the launch splash, so empty states read as "the app, waiting
// for content" rather than a bare error.
const CAIRN_ICON = require("../../assets/splashIcon.png");

// Easter egg: tap the Cairn icon this many times within the window to reveal the
// hidden mini-games menu (Breakout / Cairn stacker).
const EGG_TAPS = 5;
const EGG_WINDOW_MS = 3000;

/** Which hidden mini-game is currently open (null = none). */
type EggGame = "breakout" | "stacker" | null;

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
   *  Uses `pointerEvents="box-none"` so the blank overlay never blocks the list
   *  beneath it, while the icon + any action button stay tappable. */
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

  // Easter egg: 5 quick taps on the Cairn icon reveals a hidden mini-games menu
  // (Breakout, or the on-brand Cairn stacker). Picking one opens it full-screen.
  const [game, setGame] = useState<EggGame>(null);
  const tapTimes = useRef<number[]>([]);
  const openEggMenu = () => {
    haptics.success(); // celebratory buzz as the secret menu reveals
    const games: { label: string; value: Exclude<EggGame, null> }[] = [
      { label: "Cairn Stacker", value: "stacker" },
      { label: "Breakout", value: "breakout" },
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: "You found a secret",
          message: "Pick a hidden mini-game.",
          options: [...games.map((g) => g.label), "Cancel"],
          cancelButtonIndex: games.length,
        },
        (i) => {
          if (i >= 0 && i < games.length) setGame(games[i].value);
        },
      );
      return;
    }
    Alert.alert("You found a secret", "Pick a hidden mini-game.", [
      ...games.map((g) => ({ text: g.label, onPress: () => setGame(g.value) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  const onIconTap = () => {
    const now = Date.now();
    tapTimes.current = [...tapTimes.current, now].filter((ts) => now - ts <= EGG_WINDOW_MS);
    if (tapTimes.current.length >= EGG_TAPS) {
      tapTimes.current = [];
      openEggMenu();
    }
  };

  return (
    <View
      // Pinned overlays sit ABOVE the scroll/list content. "box-none" (not
      // "none") means the overlay's own blank area never intercepts touches — so
      // scrolling / pull-to-refresh / tapping the search bar beneath still work —
      // WHILE its interactive descendants (the Cairn icon's tap target for the
      // easter egg, and any action button like Chat's "Set up AI") stay tappable.
      // "none" would have killed those too, and did break the 5-tap egg.
      pointerEvents={pinned ? "box-none" : "auto"}
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
      <View style={styles.brand} pointerEvents={pinned ? "box-none" : "auto"}>
        <Pressable onPress={onIconTap} accessibilityLabel="Cairn">
          <Image source={CAIRN_ICON} style={{ width: iconSize, height: iconSize }} resizeMode="contain" />
        </Pressable>
        <Text style={styles.wordmark}>Cairn</Text>
        {APP_VERSION ? <Text style={styles.version}>v{APP_VERSION}</Text> : null}
      </View>

      <View style={styles.content} pointerEvents={pinned ? "box-none" : "auto"}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {children ? <View style={styles.action}>{children}</View> : null}
      </View>

      <BreakoutGame visible={game === "breakout"} onClose={() => setGame(null)} />
      <StackerGame visible={game === "stacker"} onClose={() => setGame(null)} />
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
