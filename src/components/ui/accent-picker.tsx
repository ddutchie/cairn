"use client";

/**
 * AccentPicker — chooser for the app accent colour preset.
 *
 * Two variants:
 *  - "dropdown" (default): a trigger showing the active preset (swatch + name)
 *    that opens a menu of all presets. Used on the Settings → General page.
 *  - "grid": a compact fixed-width swatch grid with no nested popover. Used
 *    inside the topbar QuickSettings dropdown, where nesting another Radix
 *    dropdown would be fragile and a full-width row would wrap awkwardly.
 *
 * Swatches always match the resolved theme so they preview what the user sees.
 */

import React from "react";
import { ChevronsUpDown, Check } from "lucide-react";
import { useCairnStore } from "@/store";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import { ACCENT_PRESETS, resolveAccentPreset } from "../../../shared/ui/accents";

function useIsLightTheme(): boolean {
  const theme = useCairnStore((s) => s.theme);
  return (
    theme === "light" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: light)").matches)
  );
}

export function AccentPicker({
  variant = "dropdown",
  className,
}: {
  variant?: "dropdown" | "grid";
  className?: string;
}) {
  const accentColor = useCairnStore((s) => s.accentColor);
  const setAccentColor = useCairnStore((s) => s.setAccentColor);
  const isLight = useIsLightTheme();

  const swatchFor = (id: string) => {
    const p = resolveAccentPreset(id);
    return isLight ? p.light.accent : p.dark.accent;
  };

  if (variant === "grid") {
    return (
      <div
        className={cn(
          "grid grid-cols-5 place-items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2",
          className
        )}
      >
        {ACCENT_PRESETS.map((preset) => {
          const active = accentColor === preset.id;
          const swatch = swatchFor(preset.id);
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => setAccentColor(preset.id)}
              title={preset.name}
              aria-label={preset.name}
              aria-pressed={active}
              className={cn(
                "relative h-5 w-5 rounded-full transition-transform hover:scale-110 focus:outline-none",
                !active && "ring-1 ring-[var(--border)]"
              )}
              style={{
                backgroundColor: swatch,
                ...(active
                  ? { boxShadow: `0 0 0 1.5px var(--surface-2), 0 0 0 3px ${swatch}` }
                  : {}),
              }}
            />
          );
        })}
      </div>
    );
  }

  const active = resolveAccentPreset(accentColor);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Accent color"
          className={cn(
            "flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]",
            "px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors",
            "hover:border-[var(--muted)] focus:outline-none",
            className
          )}
        >
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-[var(--border)]"
            style={{ backgroundColor: swatchFor(active.id) }}
          />
          <span className="flex-1 text-left">{active.name}</span>
          <ChevronsUpDown size={12} className="text-[var(--text-tertiary)]" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[220px] p-1 max-h-[320px] overflow-y-auto">
        {ACCENT_PRESETS.map((preset) => {
          const activeItem = accentColor === preset.id;
          return (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => setAccentColor(preset.id)}
              className={cn(activeItem && "text-[var(--text-primary)]")}
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-[var(--border)]"
                style={{ backgroundColor: swatchFor(preset.id) }}
              />
              <span className="flex-1">{preset.name}</span>
              {activeItem && <Check size={12} className="text-[var(--accent)]" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
