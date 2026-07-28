import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassView, GlassContainer } from "expo-glass-effect";
import { useTheme, type as typeScale, withAlpha, elevation, type Theme } from "@/theme";
import { glassActive } from "@/components/GlassBar";
import { haptics } from "@/haptics";
import type { ChatUsage } from "@/chat/providers/types";
import type { TokenBreakdown } from "@/chat/token-breakdown";

/** Width of the popover card. */
const POPOVER_WIDTH = 264;
/** Gap between the ring and the popover, and from the screen edge. */
const POPOVER_GAP = 6;
const SCREEN_MARGIN = 10;

/**
 * Context-window usage ring — the mobile analogue of the desktop ContextRing
 * (src/components/agent/ContextRing.tsx). A compact SVG donut whose arc fills
 * with the fraction of the model's context window used by the conversation.
 *
 * Tapping it pops a native-feeling Liquid Glass popover (expo-glass-effect)
 * anchored beneath the ring — rather than a bottom sheet — showing the full
 * breakdown desktop shows: a segmented bar + legend of where the prompt tokens
 * go (system prompt, tool definitions, MCP / external services, conversation,
 * tool outputs) and, once a turn completes, the output (answer / thinking)
 * split. On devices without Liquid Glass it falls back to a solid themed card.
 * Threshold colours match desktop: accent <=65%, warning 65–85%, danger >85%.
 */
export function ContextRing({
  promptTokens,
  contextLimit,
  estimated = false,
  breakdown,
  completionTokens,
  reasoningTokens,
  size = 22,
  stroke = 3.5,
}: {
  promptTokens: number;
  contextLimit: number;
  /** promptTokens is a client-side estimate (shown as "~" / "about"). */
  estimated?: boolean;
  breakdown?: TokenBreakdown;
  completionTokens?: number;
  reasoningTokens?: number;
  size?: number;
  stroke?: number;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();

  const [open, setOpen] = useState(false);
  // Screen-space anchor rect of the ring, measured on open so the popover sits
  // directly beneath it (like a native menu popping from its button).
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const triggerRef = useRef<View>(null);
  const [progress] = useState(() => new Animated.Value(0));

  const { pct, colour, r, circ, dash } = useMemo(() => {
    const p = contextLimit > 0 ? Math.min(promptTokens / contextLimit, 1) : 0;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    return {
      pct: p,
      r: radius,
      circ: circumference,
      dash: p * circumference,
      colour: p > 0.85 ? t.danger : p > 0.65 ? t.warning : t.accent,
    };
  }, [promptTokens, contextLimit, size, stroke, t]);

  const pctLabel = `${estimated ? "~" : ""}${Math.round(pct * 100)}%`;
  const half = size / 2;

  // Category segments, in the same order/colour intent as desktop.
  const categories = useMemo(() => {
    const b = breakdown;
    return [
      { label: "System prompt", count: b?.systemPrompt ?? 0, color: t.textSecondary },
      { label: "Tool definitions", count: b?.tools ?? 0, color: t.accent },
      { label: "MCP & services", count: b?.mcp ?? 0, color: t.info },
      { label: "Skills", count: b?.skills ?? 0, color: t.warning },
      { label: "Conversation", count: b?.conversation ?? 0, color: t.success },
      { label: "Tool outputs", count: b?.toolOutputs ?? 0, color: t.danger },
    ];
  }, [breakdown, t]);

  const thinkingTokens = reasoningTokens ?? 0;
  const answerTokens = Math.max(0, (completionTokens ?? 0) - thinkingTokens);
  const hasBreakdown = categories.some((c) => c.count > 0);

  const openPopover = useCallback(() => {
    haptics.selection();
    // Measure the ring in window coords so the popover anchors under it. Open
    // immediately (fallback placement) and refine once the measure lands, so a
    // slow/failed measure never leaves the popover unopened.
    setAnchor(null);
    setOpen(true);
    triggerRef.current?.measureInWindow((x, y, w, h) => {
      if (Number.isFinite(x) && Number.isFinite(y)) setAnchor({ x, y, w, h });
    });
  }, []);

  // Play the pop-in when opening; reset when closed.
  useEffect(() => {
    if (open) {
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        friction: 9,
        tension: 120,
      }).start();
    } else {
      progress.setValue(0);
    }
  }, [open, progress]);

  const ring = (
    <Svg width={size} height={size}>
      {/* -90° rotation so the arc starts at 12 o'clock, like desktop. */}
      <Circle cx={half} cy={half} r={r} fill="none" stroke={t.border} strokeWidth={stroke} />
      <Circle
        cx={half}
        cy={half}
        r={r}
        fill="none"
        stroke={colour}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${half} ${half})`}
      />
    </Svg>
  );

  const a11yLabel = `Context ${pctLabel} used${estimated ? " (estimated)" : ""}. Tap for details.`;

  // Popover placement: sit just below the ring, right-aligned to its right edge
  // but clamped inside the screen. Falls back to top-right under the safe area
  // if we have no anchor rect yet.
  const top = anchor ? anchor.y + anchor.h + POPOVER_GAP : insets.top + 44;
  const rawLeft = anchor ? anchor.x + anchor.w / 2 - POPOVER_WIDTH * 0.18 : SCREEN_MARGIN;
  const left = Math.max(
    SCREEN_MARGIN,
    Math.min(rawLeft, screenW - POPOVER_WIDTH - SCREEN_MARGIN),
  );

  // Origin for the scale animation = horizontal offset of the ring within the card.
  const originX = anchor ? Math.min(Math.max(anchor.x + anchor.w / 2 - left, 12), POPOVER_WIDTH - 12) : POPOVER_WIDTH / 2;

  const cardScale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });
  const cardTranslateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] });

  const content = (
    <View style={styles.cardInner}>
      {/* Summary row */}
      <View style={styles.summaryRow}>
        <Text style={styles.pctText}>{pctLabel} Full</Text>
        <Text style={styles.totalText}>
          {estimated ? "~" : ""}
          {formatTokenCount(promptTokens)} / {formatTokenCount(contextLimit)}
        </Text>
      </View>

      {/* Segmented bar */}
      <View style={styles.bar}>
        {hasBreakdown ? (
          categories.map((c) => {
            const widthPct = contextLimit > 0 ? (c.count / contextLimit) * 100 : 0;
            if (widthPct <= 0) return null;
            return (
              <View
                key={c.label}
                style={{ width: `${widthPct}%`, height: "100%", backgroundColor: c.color }}
              />
            );
          })
        ) : (
          <View style={{ width: `${Math.round(pct * 100)}%`, height: "100%", backgroundColor: colour }} />
        )}
      </View>

      {/* Legend */}
      {hasBreakdown ? (
        <View style={styles.legend}>
          {categories.map((c) => {
            if (c.count === 0) return null;
            return (
              <View key={c.label} style={styles.legendRow}>
                <View style={styles.legendLabel}>
                  <View style={[styles.swatch, { backgroundColor: c.color }]} />
                  <Text style={styles.legendText} numberOfLines={1}>{c.label}</Text>
                </View>
                <Text style={styles.legendCount}>{formatTokenCount(c.count)}</Text>
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={styles.hint}>A detailed breakdown appears after the next message.</Text>
      )}

      {/* Output breakdown — after a turn reports completion tokens. */}
      {typeof completionTokens === "number" && completionTokens > 0 ? (
        <View style={styles.outputSection}>
          <Text style={styles.outputTitle}>Output</Text>
          <View style={styles.legendRow}>
            <Text style={styles.legendText}>Answer</Text>
            <Text style={styles.legendCount}>{formatTokenCount(answerTokens)}</Text>
          </View>
          {thinkingTokens > 0 ? (
            <View style={styles.legendRow}>
              <View style={styles.legendLabel}>
                <View style={[styles.swatch, { backgroundColor: t.accent }]} />
                <Text style={styles.legendText}>Thinking</Text>
              </View>
              <Text style={styles.legendCount}>{formatTokenCount(thinkingTokens)}</Text>
            </View>
          ) : null}
          <View style={styles.legendRow}>
            <Text style={styles.legendTextMuted}>Total</Text>
            <Text style={styles.legendCountMuted}>{formatTokenCount(completionTokens)}</Text>
          </View>
        </View>
      ) : null}

      {estimated ? (
        <Text style={styles.estimatedNote}>Estimated for this provider.</Text>
      ) : null}
    </View>
  );

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={openPopover}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        style={styles.trigger}
      >
        {ring}
      </Pressable>

      <Modal visible={open} transparent animationType="none" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        {/* Tap-anywhere backdrop dismisses (native-menu behaviour). */}
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Animated.View
            // Stop the press from bubbling to the backdrop so taps inside the
            // card don't dismiss it.
            onStartShouldSetResponder={() => true}
            style={[
              styles.card,
              {
                top,
                left,
                width: POPOVER_WIDTH,
                // NOTE: never animate `opacity` here — setting opacity on a
                // GlassView OR any parent makes the glass effect stop rendering
                // entirely (Expo glass-effect known issue). The popover opens
                // with a scale/slide spring only; the Modal itself does not fade
                // (animationType="none") so nothing dims the glass.
                transform: [{ translateY: cardTranslateY }, { scale: cardScale }],
              },
              elevation.xl,
            ]}
          >
            {glassActive ? (
              // GlassContainer merges the arrow + card into one continuous glass
              // element (they blend where they meet). No tintColor / background —
              // the native glass material provides the backing on its own.
              <GlassContainer spacing={14} style={styles.glassContainer}>
                <GlassView
                  style={[styles.arrow, { left: originX - 6 }]}
                  glassEffectStyle="regular"
                />
                <GlassView
                  style={styles.glass}
                  glassEffectStyle="regular"
                  isInteractive
                >
                  {content}
                </GlassView>
              </GlassContainer>
            ) : (
              <>
                <View style={[styles.glass, styles.solidCard]}>{content}</View>
                <View style={[styles.arrow, styles.arrowSolid, { left: originX - 6 }]} />
              </>
            )}
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}

/** Compact token count: 1234 → "1.2K". */
function formatTokenCount(num: number): string {
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return num.toString();
}

/** Convenience: build props from a ChatUsage object. */
export type ContextRingUsage = ChatUsage;

function makeStyles(t: Theme) {
  return StyleSheet.create({
    trigger: { paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
    // Light scrim so the popover reads over the content without a heavy dim
    // (native menus barely darken the backdrop).
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.12)" },
    card: {
      position: "absolute",
      borderRadius: 16,
    },
    glassContainer: {
      borderRadius: 16,
    },
    glass: {
      borderRadius: 16,
      overflow: "hidden",
    },
    // Fallback surface when Liquid Glass isn't available.
    solidCard: {
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    // A small square rotated 45° peeking above the card toward the ring. In the
    // glass path this is a second GlassView (tinted like the card, merged by the
    // GlassContainer); in the fallback it gets a solid fill via arrowSolid.
    arrow: {
      position: "absolute",
      top: -5,
      width: 12,
      height: 12,
      borderRadius: 2,
      transform: [{ rotate: "45deg" }],
    },
    arrowSolid: {
      backgroundColor: t.surface2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    cardInner: { paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
    summaryRow: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
    },
    pctText: { ...typeScale.subtitle, fontWeight: "700", color: t.textPrimary },
    totalText: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    bar: {
      flexDirection: "row",
      height: 8,
      borderRadius: 4,
      overflow: "hidden",
      backgroundColor: withAlpha(t.border, 0.6),
      marginVertical: 12,
    },
    legend: { gap: 9 },
    legendRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    legendLabel: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
    swatch: { width: 10, height: 10, borderRadius: 3 },
    legendText: { ...typeScale.caption, color: t.textSecondary },
    legendTextMuted: { ...typeScale.caption, color: t.textTertiary },
    legendCount: { ...typeScale.caption, fontWeight: "600", color: t.textPrimary, fontVariant: ["tabular-nums"] },
    legendCountMuted: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 2 },
    outputSection: {
      marginTop: 14,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withAlpha(t.border, 0.8),
      gap: 9,
    },
    outputTitle: { ...typeScale.label, color: t.textPrimary, marginBottom: 2 },
    estimatedNote: { ...typeScale.micro, color: t.textTertiary, marginTop: 12 },
  });
}
