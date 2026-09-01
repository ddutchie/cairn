/* eslint-disable react-hooks/refs */
/**
 * Stacked toast — ported from react-native-motion spring-toast/toast.tsx
 * Adapted to Cairn theme (useTheme, lucide icons, variant colors) and keeps
 * the rnm spring/gesture stack: peek, scale, rubber-band, swipe-to-dismiss.
 */
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-react-native";
import { useTheme, withAlpha, type Theme } from "@/theme";
import type { ToastVariant } from "./Toast";

export interface StackToastConfig {
  id: number;
  message: string;
  variant: ToastVariant;
  detail?: string;
  durationMs?: number;
  actionText?: string;
  onActionPress?: () => void;
}

const ENTER_OFFSET = 200;
const HIDDEN_SCALE = 0.7;
const AUTO_DISMISS_MS = 3000;
const FADE_IN_MS = 200;
const EXIT_MS = 160;
const EXIT_DROP = 40;
const SWIPE_EXIT_DROP = 80;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const DISMISS_DISTANCE = 56;
const DISMISS_VELOCITY = 800;
const STACK_PEEK = 14;
const STACK_SCALE_STEP = 0.05;
const MAX_VISIBLE = 3;

function rubberBand(distance: number) {
  "worklet";
  return (40 * distance) / (distance + 120);
}

const VARIANT_ICON = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
};

function variantColor(t: Theme, v: ToastVariant): string {
  switch (v) {
    case "success": return t.success;
    case "warning": return t.warning;
    case "error": return t.danger;
    default: return t.info;
  }
}

export function StackToast({
  toast,
  index,
  onDismissStart,
  onDismissed,
}: {
  toast: StackToastConfig;
  index: number;
  onDismissStart: (id: number) => void;
  onDismissed: (id: number) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();

  const progress = useSharedValue(0);
  const opacity = useSharedValue(0);
  const dragY = useSharedValue(0);
  const stackY = useSharedValue(-index * STACK_PEEK);
  const stackScale = useSharedValue(1 - index * STACK_SCALE_STEP);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitingRef = useRef(false);
  const indexRef = useRef(index);
  indexRef.current = index;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finishDismiss = useCallback(() => onDismissed(toast.id), [onDismissed, toast.id]);

  const dismiss = useCallback(
    (kind: "timeout" | "close" | "swipe") => {
      if (exitingRef.current) return;
      exitingRef.current = true;
      clearTimer();
      onDismissStart(toast.id);
      opacity.set(withTiming(0, { duration: EXIT_MS }, (finished) => { if (finished) scheduleOnRN(finishDismiss); }));
      if (reduced) return;
      if (kind === "swipe") {
        dragY.set(withTiming(dragY.get() + SWIPE_EXIT_DROP, { duration: EXIT_MS, easing: EASE_OUT }));
      } else if (indexRef.current === 0) {
        dragY.set(withTiming(EXIT_DROP, { duration: EXIT_MS, easing: EASE_OUT }));
      }
    },
    [clearTimer, dragY, finishDismiss, onDismissStart, opacity, reduced, toast.id],
  );

  const restartTimer = useCallback(() => {
    if (exitingRef.current) return;
    clearTimer();
    const dur = toast.durationMs ?? AUTO_DISMISS_MS;
    timerRef.current = setTimeout(() => dismiss("timeout"), dur);
  }, [clearTimer, dismiss, toast.durationMs]);

  const commitSwipeDismiss = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dismiss("swipe");
  }, [dismiss]);

  useEffect(() => {
    progress.set(reduced ? 1 : withSpring(1));
    opacity.set(withTiming(1, { duration: FADE_IN_MS }));
    restartTimer();
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (exitingRef.current) return;
    const y = -index * STACK_PEEK;
    const scale = 1 - index * STACK_SCALE_STEP;
    stackY.set(reduced ? y : withSpring(y));
    stackScale.set(reduced ? scale : withSpring(scale));
    if (index >= MAX_VISIBLE) {
      opacity.set(withTiming(0, { duration: FADE_IN_MS }));
    } else {
      opacity.set(withTiming(1, { duration: FADE_IN_MS }));
    }
  }, [index, opacity, reduced, stackScale, stackY]);

  const pan = Gesture.Pan()
    .enabled(index === 0)
    .onBegin(() => { scheduleOnRN(clearTimer); })
    .onUpdate((e) => { dragY.set(e.translationY >= 0 ? e.translationY : -rubberBand(-e.translationY)); })
    .onEnd((e) => {
      if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) scheduleOnRN(commitSwipeDismiss);
      else { dragY.set(withSpring(0)); scheduleOnRN(restartTimer); }
    })
    .onFinalize((_e, success) => { if (!success) scheduleOnRN(restartTimer); });

  const animatedStyle = useAnimatedStyle(() => {
    const p = progress.get();
    return {
      opacity: opacity.value,
      transform: [{ translateY: (1 - p) * ENTER_OFFSET + stackY.get() + dragY.get() }, { scale: (HIDDEN_SCALE + (1 - HIDDEN_SCALE) * p) * stackScale.get() }],
    };
  });

  const handleAction = () => {
    toast.onActionPress?.();
    dismiss("close");
  };

  const color = variantColor(t, toast.variant);
  const Icon = VARIANT_ICON[toast.variant];
  const bottom = 16 + insets.bottom * 0.5 + 49 * 0.5; // above tab bar

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.container, { bottom, backgroundColor: t.surface2, borderColor: withAlpha(color, 0.5) }, animatedStyle]}>
        <View style={styles.content}>
          <View style={[styles.iconWrap, { backgroundColor: withAlpha(color, 0.16) }]}>
            <Icon size={17} color={color} />
          </View>
          <View style={styles.textCol}>
            <Text style={[styles.message, { color: t.textPrimary }]} numberOfLines={2}>{toast.message}</Text>
            {toast.detail ? <Text style={[styles.detail, { color: t.textSecondary }]} numberOfLines={1}>{toast.detail}</Text> : null}
          </View>
          {toast.actionText && toast.onActionPress ? (
            <Pressable onPress={handleAction} hitSlop={8} style={styles.actionButton}>
              <Text style={[styles.actionText, { color: t.textPrimary }]}>{toast.actionText}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss notification" onPress={() => dismiss("close")} hitSlop={8} style={styles.closeButton}>
            <X size={16} color={t.textTertiary} />
          </Pressable>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: { position: "absolute", left: 16, right: 16, borderRadius: 14, borderWidth: 1, zIndex: 100, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 8 },
  content: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
  iconWrap: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  textCol: { flexShrink: 1, flex: 1 },
  message: { fontSize: 15, fontWeight: "600" },
  detail: { fontSize: 13, marginTop: 2 },
  actionButton: { paddingHorizontal: 8, paddingVertical: 6 },
  actionText: { fontSize: 12, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: "600" },
  closeButton: { padding: 4 },
});
