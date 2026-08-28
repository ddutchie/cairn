import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { haptics } from "@/haptics";
import { ConfettiHost } from "@/components/Confetti";
import { StackToast } from "./StackToast";

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
  exiting?: boolean;
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

/** Which haptic fires per toast variant ("info" has no notification style → a
 *  subtle impact). */
const VARIANT_HAPTIC: Record<ToastVariant, () => void> = {
  success: haptics.success,
  info: haptics.impact,
  warning: haptics.warning,
  error: haptics.error,
};

const DEFAULT_DURATION = 3000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const seq = useRef(0);

  const show = useCallback((message: string, opts?: ToastOptions) => {
    const variant = opts?.variant ?? "info";
    if (opts?.haptic !== false) VARIANT_HAPTIC[variant]();
    AccessibilityInfo.announceForAccessibility(opts?.detail ? `${message}. ${opts.detail}` : message);
    seq.current += 1;
    setToasts((prev) => [
      ...prev,
      {
        id: seq.current,
        message,
        variant,
        detail: opts?.detail,
        durationMs: opts?.durationMs ?? DEFAULT_DURATION,
      },
    ]);
  }, []);

  const handleDismissStart = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
  }, []);

  const handleDismissed = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

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

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.map((toastEntry) => (
        <StackToast
          key={toastEntry.id}
          toast={toastEntry}
          index={toasts.filter((t) => !t.exiting && t.id > toastEntry.id).length}
          onDismissStart={handleDismissStart}
          onDismissed={handleDismissed}
        />
      ))}
      <ConfettiHost />
    </ToastContext.Provider>
  );
}
