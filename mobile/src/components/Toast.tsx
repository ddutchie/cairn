import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, AccessibilityInfo } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { CheckCircle2, Info, AlertTriangle, XCircle, type LucideIcon } from "lucide-react-native";
import { useTheme, withAlpha, elevation, type as typeScale, iconSize, TAB_BAR_BASE, type Theme } from "@/theme";
import { haptics } from "@/haptics";
import { ConfettiHost } from "@/components/Confetti";

/**
 * Lightweight toast / snackbar system — Cairn had none, so reward moments (task
 * done, streaks, milestones) had nowhere to surface a quick, non-blocking
 * message. A single toast shows at a time near the bottom, above the native tab
 * bar; a new toast replaces the current one (rapid actions queue via replace,
 * not stack, so we never tower up the screen).
 *
 * Two ways to fire:
 *   - `useToast()` inside a component
 *   - the module-level `toast` singleton from anywhere (board drop handlers,
 *     db-adjacent code) — it no-ops safely until the provider has mounted.
 *
 * The provider also fires the matching haptic for the variant, so callers get
 * tactile + visual feedback from one call. Pass `haptic: false` to suppress it
 * (e.g. when the call site already fired its own).
 */

export type ToastVariant = "success" | "info" | "warning" | "error";

export interface ToastOptions {
  /** Visual + haptic style. Default "info". */
  variant?: ToastVariant;
  /** Optional smaller line under the message (e.g. a streak count). */
  detail?: string;
  /** Auto-dismiss delay in ms. Default 2400. */
  durationMs?: number;
  /** Fire the variant's haptic. Default true. */
  haptic?: boolean;
}

interface ToastApi {
  show: (message: string, opts?: ToastOptions) => void;
  success: (message: string, opts?: Omit<ToastOptions, "variant">) => void;
  info: (message: string, opts?: Omit<ToastOptions, "variant">) => void;
  warning: (message: string, opts?: Omit<ToastOptions, "variant">) => void;
  error: (message: string, opts?: Omit<ToastOptions, "variant">) => void;
}

interface ToastState {
  id: number;
  message: string;
  variant: ToastVariant;
  detail?: string;
  durationMs: number;
}

const ToastContext = createContext<ToastApi | null>(null);

// Module-level bridge so non-component code (drag-drop handlers, save flows) can
// fire a toast without prop-drilling a callback. Wired up by the provider on
// mount; a no-op before that (and after unmount).
let externalShow: ((message: string, opts?: ToastOptions) => void) | null = null;

/** Fire a toast from anywhere. Safe no-op until <ToastProvider> has mounted. */
export const toast: ToastApi = {
  show: (message, opts) => externalShow?.(message, opts),
  success: (message, opts) => externalShow?.(message, { ...opts, variant: "success" }),
  info: (message, opts) => externalShow?.(message, { ...opts, variant: "info" }),
  warning: (message, opts) => externalShow?.(message, { ...opts, variant: "warning" }),
  error: (message, opts) => externalShow?.(message, { ...opts, variant: "error" }),
};

/** Hook form — identical API to the {@link toast} singleton. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const VARIANT_ICON: Record<ToastVariant, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
};

/** Which haptic fires per toast variant ("info" has no notification style → a
 *  subtle impact). */
const VARIANT_HAPTIC: Record<ToastVariant, () => void> = {
  success: haptics.success,
  info: haptics.impact,
  warning: haptics.warning,
  error: haptics.error,
};

function variantColor(t: Theme, v: ToastVariant): string {
  switch (v) {
    case "success": return t.success;
    case "warning": return t.warning;
    case "error": return t.danger;
    default: return t.info;
  }
}

const DEFAULT_DURATION = 2400;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ToastState | null>(null);
  const seq = useRef(0);

  const show = useCallback((message: string, opts?: ToastOptions) => {
    const variant = opts?.variant ?? "info";
    if (opts?.haptic !== false) VARIANT_HAPTIC[variant]();
    seq.current += 1;
    setState({
      id: seq.current,
      message,
      variant,
      detail: opts?.detail,
      durationMs: opts?.durationMs ?? DEFAULT_DURATION,
    });
  }, []);

  // `show` is stable (empty-dep useCallback), so the api object is built once.
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m, o) => show(m, { ...o, variant: "success" }),
      info: (m, o) => show(m, { ...o, variant: "info" }),
      warning: (m, o) => show(m, { ...o, variant: "warning" }),
      error: (m, o) => show(m, { ...o, variant: "error" }),
    }),
    [show],
  );

  useEffect(() => {
    externalShow = show;
    return () => {
      if (externalShow === show) externalShow = null;
    };
  }, [show]);

  const clear = useCallback(() => setState(null), []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {state ? <ToastCard key={state.id} state={state} onDone={clear} /> : null}
      <ConfettiHost />
    </ToastContext.Provider>
  );
}

/**
 * The animated toast surface. Springs up + fades in on mount, auto-dismisses
 * after `durationMs`, then fades/slides out and calls `onDone` to unmount. A
 * fresh toast remounts this (keyed on id), so replacing the current toast
 * restarts the animation cleanly.
 */
function ToastCard({ state, onDone }: { state: ToastState; onDone: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(24);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 180 });
    translateY.value = withSpring(0, { damping: 16, stiffness: 240, mass: 0.5 });

    // The toast is pointerEvents="none" and purely visual, so announce it to
    // screen readers (VoiceOver / TalkBack) — otherwise its message is silent
    // for assistive-tech users.
    AccessibilityInfo.announceForAccessibility(
      state.detail ? `${state.message}. ${state.detail}` : state.message,
    );

    const timer = setTimeout(() => {
      opacity.value = withTiming(0, { duration: 200 });
      translateY.value = withTiming(16, { duration: 200 }, (finished) => {
        if (finished) runOnJS(onDone)();
      });
    }, state.durationMs);

    return () => clearTimeout(timer);
    // Animation is driven once per mount (component is keyed on toast id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const color = variantColor(t, state.variant);
  const Icon = VARIANT_ICON[state.variant];
  // Rest above the native tab bar / home indicator (see theme.ts note: the
  // reported bottom inset already includes the tab bar on tab screens).
  const bottom = TAB_BAR_BASE + insets.bottom * 0.5 + 12;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { bottom }, animStyle]}
    >
      <View
        style={[
          styles.card,
          elevation.lg,
          { backgroundColor: t.surface2, borderColor: withAlpha(color, 0.5) },
        ]}
      >
        <View style={[styles.iconWrap, { backgroundColor: withAlpha(color, 0.16) }]}>
          <Icon size={iconSize.control} color={color} />
        </View>
        <View style={styles.textCol}>
          <Text style={[styles.message, { color: t.textPrimary }]} numberOfLines={2}>
            {state.message}
          </Text>
          {state.detail ? (
            <Text style={[styles.detail, { color: t.textSecondary }]} numberOfLines={1}>
              {state.detail}
            </Text>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    alignItems: "center",
    zIndex: 2000,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    maxWidth: 420,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  textCol: { flexShrink: 1 },
  message: { ...typeScale.control, fontWeight: "600" },
  detail: { ...typeScale.caption, marginTop: 2 },
});
