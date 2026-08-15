"use client";

/**
 * QuickSettings — compact theme + font-scale popover for the topbar.
 * Rendered as a Radix DropdownMenu so it dismisses on outside click / Escape.
 */

import React from "react";
import { Settings2, Sun, Moon, Monitor } from "lucide-react";
import { useCairnStore } from "@/store";
import type { Theme, FontScale, FontFamilyId } from "@/store/slices/ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { AccentPicker } from "@/components/ui/accent-picker";
import { FONT_PRESETS } from "../../../shared/ui/fonts";

// ── Theme options ─────────────────────────────────────────────────────────────

const THEMES: SegmentedControlOption<Theme>[] = [
  { value: "dark",   label: "Dark",   icon: <Moon size={12} /> },
  { value: "light",  label: "Light",  icon: <Sun size={12} /> },
  { value: "system", label: "System", icon: <Monitor size={12} /> },
];

// ── Font scale options ────────────────────────────────────────────────────────

const FONT_SCALES: SegmentedControlOption<FontScale>[] = [
  { value: 1,   label: "XS" },
  { value: 1.1, label: "S"  },
  { value: 1.2, label: "M"  },
  { value: 1.3, label: "L"  },
  { value: 1.4, label: "XL" },
];

// ── Note-text font options ────────────────────────────────────────────────────

const NOTE_FONTS: SegmentedControlOption<FontFamilyId>[] = FONT_PRESETS.map((p) => ({
  value: p.id as FontFamilyId,
  label: p.name,
}));

// ── Component ─────────────────────────────────────────────────────────────────

export function QuickSettings() {
  const theme = useCairnStore((s) => s.theme);
  const setTheme = useCairnStore((s) => s.setTheme);
  const fontScale = useCairnStore((s) => s.fontScale);
  const setFontScale = useCairnStore((s) => s.setFontScale);
  const fontFamily = useCairnStore((s) => s.fontFamily);
  const setFontFamily = useCairnStore((s) => s.setFontFamily);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Quick settings">
          <Settings2 size={13} />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[260px] p-3">

        {/* Theme */}
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <div className="px-1 pb-2">
          <SegmentedControl
            options={THEMES}
            value={theme}
            onChange={setTheme}
            className="w-full text-[0.714rem]"
          />
        </div>

        <DropdownMenuSeparator />

        {/* Accent colour */}
        <DropdownMenuLabel className="mt-2">Accent color</DropdownMenuLabel>
        <div className="px-1 pb-2">
          <AccentPicker variant="grid" className="w-full" />
        </div>

        <DropdownMenuSeparator />

        {/* Font scale */}
        <DropdownMenuLabel className="mt-2">Font size</DropdownMenuLabel>
        <div className="px-1 pb-2">
          <SegmentedControl
            options={FONT_SCALES}
            value={fontScale}
            onChange={setFontScale}
            className="w-full text-[0.714rem]"
          />
        </div>

        {/* Note font */}
        <DropdownMenuLabel className="mt-2">Note font</DropdownMenuLabel>
        <div className="px-1 pb-1">
          <SegmentedControl
            options={NOTE_FONTS}
            value={fontFamily}
            onChange={setFontFamily}
            className="w-full text-[0.714rem]"
          />
        </div>

      </DropdownMenuContent>
    </DropdownMenu>
  );
}
