"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";

const DEFAULT_DISARM_MS = 4000;

interface ConfirmState {
  armed: boolean;
  /** First click — arms the confirm (auto-disarms after `timeoutMs`). */
  arm: () => void;
  /** Second click — fires and disarms. */
  fire: () => void;
  disarm: () => void;
}

/**
 * Two-step destructive-confirm hook. Replaces both `window.confirm(...)`
 * (blocking, untestable, off-brand) and the three hand-rolled
 * `confirmX + setTimeout(disarm, 4000)` clones.
 */
export function useConfirmAction(timeoutMs: number = DEFAULT_DISARM_MS): ConfirmState {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setArmed(false);
  }, []);

  const arm = useCallback(() => {
    setArmed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setArmed(false);
    }, timeoutMs);
  }, [timeoutMs]);

  const fire = useCallback(() => {
    disarm();
  }, [disarm]);

  useEffect(() => disarm, [disarm]);

  return { armed, arm, fire, disarm };
}

interface ConfirmButtonProps extends Omit<ButtonProps, "onClick"> {
  /** Label shown once armed. Defaults to "Are you sure?" (or "Confirm" when
   *  space is tight — pass `confirmLabel="Confirm"` for icon-adjacent rows). */
  confirmLabel?: ReactNode;
  /** Fire callback (second click). */
  onConfirm: () => void;
  /** Render a Cancel button next to the armed confirm. */
  showCancel?: boolean;
  /**
   * Classes for the armed confirm button. Defaults to the trigger's
   * `className` — pass this when the trigger carries layout classes (e.g.
   * `w-full`) that must not apply to the armed state.
   */
  armedClassName?: string;
}

/**
 * Drop-in two-step confirm button. First click arms (swaps to the danger
 * `confirmLabel`, auto-disarms after 4s); second click fires `onConfirm`.
 * For fully custom triggers (icon rows, per-item lists) use
 * `useConfirmAction` directly.
 */
export function ConfirmButton({
  confirmLabel = "Are you sure?",
  onConfirm,
  showCancel = false,
  armedClassName,
  children,
  ...buttonProps
}: ConfirmButtonProps) {
  const { armed, arm, fire, disarm } = useConfirmAction();

  if (!armed) {
    return (
      <Button {...buttonProps} onClick={arm}>
        {children}
      </Button>
    );
  }

  return (
    <>
      <Button {...buttonProps} variant="danger" className={armedClassName ?? buttonProps.className} onClick={() => { fire(); onConfirm(); }}>
        {confirmLabel}
      </Button>
      {showCancel && (
        <Button variant="ghost" size={buttonProps.size ?? "md"} onClick={disarm}>
          Cancel
        </Button>
      )}
    </>
  );
}
