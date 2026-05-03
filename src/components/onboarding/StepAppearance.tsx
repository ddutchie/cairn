"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Theme, FontScale } from "@/store/slices/ui";
import { applyTheme, applyFontScale } from "@/store/slices/ui";
import { Shell, NavRow, FONT_OPTS } from "./shared";

interface Props {
  theme: Theme;
  fontScale: FontScale;
  onThemeChange: (t: Theme) => void;
  onFontScaleChange: (s: FontScale) => void;
  onNext: () => void;
}

const THEME_OPTS: { value: Theme; label: string; icon: React.ReactNode; desc: string }[] = [
  { value: "light",  label: "Light",  icon: <Sun size={16} />,     desc: "Clean and bright" },
  { value: "system", label: "System", icon: <Monitor size={16} />, desc: "Follows your OS" },
  { value: "dark",   label: "Dark",   icon: <Moon size={16} />,    desc: "Easy on the eyes" },
];

export function StepAppearance({ theme, fontScale, onThemeChange, onFontScaleChange, onNext }: Props) {
  function handleTheme(t: Theme) {
    onThemeChange(t);
    applyTheme(t);
  }

  function handleFontScale(s: FontScale) {
    onFontScaleChange(s);
    applyFontScale(s);
  }

  return (
    <Shell step="appearance">
      <div className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-6">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-0.5">Make it yours</h2>
          <p className="text-xs text-[var(--text-tertiary)]">
            Choose a theme and text size. You can always change these in Settings.
          </p>
        </div>

        {/* Theme */}
        <div>
          <p className="text-xs font-medium text-[var(--text-secondary)] mb-2.5">Theme</p>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleTheme(opt.value)}
                className={cn(
                  "flex flex-col items-center gap-2 p-3 rounded-xl border transition-all",
                  theme === opt.value
                    ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                )}
              >
                {opt.icon}
                <span className="text-xs font-medium">{opt.label}</span>
                <span className="text-[0.65rem] opacity-60">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Font size */}
        <div>
          <p className="text-xs font-medium text-[var(--text-secondary)] mb-2.5">Text size</p>
          <div className="flex items-stretch gap-2">
            {FONT_OPTS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleFontScale(opt.value)}
                className={cn(
                  "flex-1 flex flex-col items-center gap-1 py-2.5 rounded-xl border transition-all",
                  fontScale === opt.value
                    ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                )}
              >
                <span style={{ fontSize: `${opt.value * 10}px`, lineHeight: 1, fontWeight: 600 }}>
                  Aa
                </span>
                <span className="text-[0.65rem] font-medium">{opt.label}</span>
              </button>
            ))}
          </div>

          {/* Live preview */}
          <p className="mt-3 text-[var(--text-secondary)] text-sm leading-relaxed px-1">
            The quick brown fox jumps over the lazy dog.{" "}
            <span className="text-[var(--accent)] font-medium">Notes · Board · Insights</span>
          </p>
        </div>

        <NavRow onNext={onNext} />
      </div>
    </Shell>
  );
}
