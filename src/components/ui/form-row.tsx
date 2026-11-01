"use client";

/**
 * Form-row primitives for settings-like surfaces (Settings pages, onboarding,
 * provider forms). Promoted from `settings/shared.tsx` (now a re-export shim)
 * so non-settings surfaces stop forking their own row geometry.
 */

import React, { useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Toggle as UiToggle, type ToggleProps } from "@/components/ui/toggle";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";

/**
 * Buttons and links keep their own text as their accessible name; anything
 * else gets the row's label (via an injected id). Otherwise a screen reader
 * announces "Browse Community" as "Community providers, button". The check is
 * shallow: a button wrapped in another component (e.g. a Tooltip or a
 * DropdownMenuTrigger) still gets the id.
 */
function isActionElement(node: React.ReactNode): boolean {
  if (!React.isValidElement(node)) return false;
  return node.type === "button" || node.type === "a" || node.type === Button || node.type === IconButton;
}

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
    <div data-settings-label={title} className="scroll-mt-4 rounded-lg">
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
  const labelsControl = React.isValidElement(children) && !isActionElement(children);
  return (
    <div data-settings-label={label} className="scroll-mt-4 flex flex-col @sm:flex-row @sm:items-start @sm:justify-between gap-2 @sm:gap-6 py-3 border-b border-[var(--border-subtle)]">
      <div className="flex-1 min-w-0">
        <label htmlFor={labelsControl ? id : undefined} className="text-sm text-[var(--text-secondary)] cursor-default">{label}</label>
        {description && (
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      <div className={controlClassName ?? "flex-shrink-0 @sm:self-auto"}>
        {/* Inject id into a single form-control child so the row label names it */}
        {labelsControl
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

/**
 * A SettingsRow whose control is one segmented well: optional Auto, preset
 * values, and a custom number as the last segment. Used for max steps,
 * temperature, context window and max output across AISettings and
 * AgentSettings.
 */
export function StepperSettingsRow({
  label,
  description,
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
  // When Auto is active and represents "no value", the row shows nothing
  // selected: empty input (placeholder) and no highlighted preset.
  const suppressed = Boolean(autoSuppressesValue && autoActive);

  // One control per value: presets, Auto and a custom number share a single
  // segmented well (same treatment as Theme / Font size), so the row no longer
  // shows an input and a chip strip that both edit the same number.
  const autoOn = Boolean(onAuto) && (autoActive ?? (autoState === "detected" && autoValue != null && value === autoValue));
  const presetOn = (n: number) => !suppressed && !autoOn && value === n;
  const customOn = !suppressed && !autoOn && !presets.includes(value);

  // The custom field shows a number only when the value is custom; otherwise
  // it's an empty "Custom" slot. `draft` is non-null only while typing, and a
  // blur commits only what was typed, so tabbing through never turns Auto off.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (customOn ? String(value) : "");

  function commit() {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    if (raw === "" || raw === (customOn ? String(value) : "")) return;
    const v = step && step < 1 ? parseFloat(raw) : parseInt(raw, 10);
    if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
  }
  const segment = (on: boolean) => cn(
    "px-2 py-1 rounded-md text-xs transition-colors",
    on ? "bg-[var(--surface)] text-[var(--text-primary)] font-medium shadow-elev-1" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
  );
  return (
    <SettingsRow label={label} description={description} controlClassName="min-w-0 @sm:self-auto">
      <div role="group" aria-label={label} className="inline-flex flex-wrap items-center justify-end gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
        {onAuto && (
          <button
            type="button"
            onClick={onAuto}
            disabled={autoState === "loading"}
            aria-pressed={autoOn}
            title={
              autoState === "detected" && autoValue
                ? `Detected ${autoValue.toLocaleString()} from models.dev`
                : autoState === "not_found"
                  ? "Not found in models.dev, so a safe default applies"
                  : "Detect from models.dev"
            }
            className={cn(segment(autoOn), "inline-flex items-center gap-1", autoState === "loading" && "opacity-60 cursor-wait")}
          >
            {autoState === "loading" && <Spinner size={10} />}
            Auto
          </button>
        )}
        {presets.map((n) => (
          <button key={n} type="button" onClick={() => onChange(n)} aria-pressed={presetOn(n)} className={segment(presetOn(n))}>
            {formatPreset ? formatPreset(n) : n}
          </button>
        ))}
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          aria-label={`${label}, custom value`}
          value={shown}
          placeholder={suppressed ? suppressedPlaceholder : "Custom"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
          }}
          className={cn(
            "h-7 border-transparent bg-transparent px-2 py-1 text-xs text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none",
            inputWidth === "w-24" ? "w-20" : inputWidth,
            customOn && "bg-[var(--surface)] text-[var(--text-primary)] shadow-elev-1",
          )}
        />
      </div>
    </SettingsRow>
  );
}
