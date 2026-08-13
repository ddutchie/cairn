"use client";

import React, { useState, useRef, useEffect } from "react";
import { Footprints, Thermometer, Layers, Gauge, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Toggle as UiToggle, type ToggleProps } from "@/components/ui/toggle";

// ── Layout helpers ────────────────────────────

export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
        {description && (
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  controlClassName,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  /** Overrides the control slot's flex classes (defaults to non-shrinking so
   *  toggles/inputs keep their natural width). Rows with multi-button controls
   *  pass `min-w-0 @sm:self-auto` so the buttons wrap instead of overflowing
   *  on narrow pages. */
  controlClassName?: string;
}) {
  const id = React.useId();
  return (
    <div className="flex flex-col @sm:flex-row @sm:items-start @sm:justify-between gap-2 @sm:gap-6 py-3 border-b border-[var(--border-subtle)]">
      <div className="flex-1 min-w-0">
        <label htmlFor={id} className="text-sm text-[var(--text-secondary)] cursor-default">{label}</label>
        {description && (
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      <div className={controlClassName ?? "flex-shrink-0 @sm:self-auto"}>
        {/* Inject id into the first form-control child if it accepts it */}
        {React.isValidElement(children)
          ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
          : children}
      </div>
    </div>
  );
}

// ── Toggle switch ─────────────────────────────

/**
 * Settings-flavoured Toggle. Wraps the canonical `ui/toggle` but keeps the
 * settings-local `onChange` prop name for its existing callers, while
 * forwarding the rest of the canonical `ToggleProps` surface (`disabled`,
 * `className`, `label`, `id`) so settings code has a single import path that
 * supports every supported prop.
 */
export function Toggle({
  checked,
  onChange,
  label,
  id,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
} & Pick<ToggleProps, "label" | "id" | "disabled" | "className">) {
  return (
    <UiToggle
      checked={checked}
      onCheckedChange={onChange}
      label={label}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}

// ── Stepper settings row ───────────────────────

export type StepperIcon = "footprints" | "thermometer" | "layers" | "gauge";

const ICON_MAP: Record<StepperIcon, React.ComponentType<{ size?: number; className?: string }>> = {
  footprints: Footprints,
  thermometer: Thermometer,
  layers: Layers,
  gauge: Gauge,
};

/**
 * A SettingsRow with an icon-prefixed number input and preset quick-buttons.
 * Used for maxSteps, temperature, and contextLimit across AISettings and AgentSettings.
 */
export function StepperSettingsRow({
  label,
  description,
  icon,
  value,
  onChange,
  presets,
  min,
  max,
  step,
  inputWidth = "w-24",
  formatPreset,
  autoValue,
  autoState,
  autoActive,
  onAuto,
  autoSuppressesValue,
  suppressedPlaceholder = "Auto",
}: {
  label: string;
  description?: string;
  icon: StepperIcon;
  value: number;
  onChange: (v: number) => void;
  presets: readonly number[];
  min: number;
  max: number;
  step?: number;
  inputWidth?: string;
  formatPreset?: (n: number) => string;
  /** When set, the "Auto" button reflects this detected value (highlighted when applied). */
  autoValue?: number;
  /** Lifecycle of the auto-detect lookup, drives the Auto button label/spinner. */
  autoState?: "idle" | "loading" | "detected" | "not_found";
  /** When true, the Auto button is shown active regardless of value equality (source of truth for Auto mode). */
  autoActive?: boolean;
  /** Handler for the "Auto" quick-button (e.g. detect + apply a models.dev value). Always renders the button when provided. */
  onAuto?: () => void;
  /**
   * When true, Auto means "no explicit value" (not "auto-applied number"), so
   * the input shows a placeholder and no preset is highlighted — otherwise a
   * previously-typed number lingers as if still selected after tapping Auto.
   */
  autoSuppressesValue?: boolean;
  /** Placeholder shown in the input when the value is suppressed by Auto. */
  suppressedPlaceholder?: string;
}) {
  const Icon = ICON_MAP[icon];
  const [draft, setDraft] = useState(String(value));
  const blurringRef = useRef(false);
  // When Auto is active and represents "no value", the row shows nothing
  // selected: empty input (placeholder) and no highlighted preset.
  const suppressed = Boolean(autoSuppressesValue && autoActive);

  useEffect(() => {
    if (!blurringRef.current) setDraft(String(value));
  }, [value]);

  function commit(raw: string) {
    const v = step && step < 1 ? parseFloat(raw) : parseInt(raw, 10);
    if (!isNaN(v)) {
      const clamped = Math.max(min, Math.min(max, v));
      onChange(clamped);
      setDraft(String(clamped));
    } else {
      setDraft(String(value));
    }
  }

  return (
    <SettingsRow label={label} description={description}>
      <div className="flex flex-col gap-1.5 items-end">
        <div className="relative">
          <Icon size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={suppressed ? "" : draft}
            placeholder={suppressed ? suppressedPlaceholder : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              blurringRef.current = true;
              commit(draft);
              requestAnimationFrame(() => { blurringRef.current = false; });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className={cn(
              "pl-7 pr-3 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]",
              inputWidth,
            )}
          />
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {onAuto && (
            <button
              onClick={onAuto}
              disabled={autoState === "loading"}
              title={
                autoState === "detected" && autoValue
                  ? `Detected ${autoValue.toLocaleString()} tokens from models.dev`
                  : autoState === "not_found"
                    ? "Not found in models.dev — applies a safe default"
                    : "Detect from models.dev"
              }
              className={cn(
                "px-2 py-1 text-[0.714rem] rounded border transition-colors inline-flex items-center gap-1",
                (autoActive ?? (autoState === "detected" && autoValue != null && value === autoValue))
                  ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]",
                autoState === "loading" && "opacity-60 cursor-wait",
              )}
            >
              {autoState === "loading" && <Loader2 size={10} className="animate-spin" />}
              Auto
            </button>
          )}
          {presets.map((n) => (
            <button
              key={n}
              onClick={() => onChange(n)}
              className={cn(
                "px-2 py-1 text-[0.714rem] rounded border transition-colors",
                !suppressed && value === n
                  ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
              )}
            >
              {formatPreset ? formatPreset(n) : n}
            </button>
          ))}
        </div>
      </div>
    </SettingsRow>
  );
}
