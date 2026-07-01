"use client";

import React, { useState, useRef, useEffect } from "react";
import { Footprints, Thermometer, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Toggle as UiToggle } from "@/components/ui/toggle";

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
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-[var(--border-subtle)]">
      <div className="flex-1 min-w-0">
        <label htmlFor={id} className="text-sm text-[var(--text-secondary)] cursor-default">{label}</label>
        {description && (
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">
        {/* Inject id into the first form-control child if it accepts it */}
        {React.isValidElement(children)
          ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
          : children}
      </div>
    </div>
  );
}

// ── Toggle switch ─────────────────────────────

export function Toggle({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  id?: string;
}) {
  return (
    <UiToggle checked={checked} onCheckedChange={onChange} label={label} id={id} />
  );
}

// ── Stepper settings row ───────────────────────

export type StepperIcon = "footprints" | "thermometer" | "layers";

const ICON_MAP: Record<StepperIcon, React.ComponentType<{ size?: number; className?: string }>> = {
  footprints: Footprints,
  thermometer: Thermometer,
  layers: Layers,
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
}) {
  const Icon = ICON_MAP[icon];
  const [draft, setDraft] = useState(String(value));
  const blurringRef = useRef(false);

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
            value={draft}
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
        <div className="flex gap-1.5">
          {presets.map((n) => (
            <button
              key={n}
              onClick={() => onChange(n)}
              className={cn(
                "px-2 py-1 text-[0.714rem] rounded border transition-colors",
                value === n
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
