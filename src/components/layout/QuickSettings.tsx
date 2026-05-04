"use client";

/**
 * QuickSettings — compact theme + font-scale popover for the topbar.
 * Rendered as a Radix DropdownMenu so it dismisses on outside click / Escape.
 */

import { Settings2, Sun, Moon, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { Theme, FontScale } from "@/store/slices/ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";

// ── Theme options ─────────────────────────────────────────────────────────────

const THEMES: { value: Theme; label: string; icon: React.FC<{ size?: number; className?: string }> }[] = [
  { value: "dark",   label: "Dark",   icon: Moon },
  { value: "light",  label: "Light",  icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

// ── Font scale options ────────────────────────────────────────────────────────

const FONT_SCALES: { value: FontScale; label: string }[] = [
  { value: 1,   label: "XS" },
  { value: 1.1, label: "S"  },
  { value: 1.2, label: "M"  },
  { value: 1.3, label: "L"  },
  { value: 1.4, label: "XL" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function QuickSettings() {
  const theme = useCairnStore((s) => s.theme);
  const setTheme = useCairnStore((s) => s.setTheme);
  const fontScale = useCairnStore((s) => s.fontScale);
  const setFontScale = useCairnStore((s) => s.setFontScale);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Quick settings">
          <Settings2 size={13} />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-48 p-2">

        {/* Theme */}
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <div className="flex gap-1 px-1 pb-1">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={cn(
                "flex-1 flex flex-col items-center gap-1 py-1.5 rounded-md text-[0.714rem] transition-colors",
                theme === value
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>

        <DropdownMenuSeparator />

        {/* Font scale */}
        <DropdownMenuLabel>Font size</DropdownMenuLabel>
        <div className="flex gap-1 px-1 pb-1">
          {FONT_SCALES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setFontScale(value)}
              className={cn(
                "flex-1 py-1 rounded-md text-[0.714rem] font-medium transition-colors",
                fontScale === value
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {label}
            </button>
          ))}
        </div>

      </DropdownMenuContent>
    </DropdownMenu>
  );
}
