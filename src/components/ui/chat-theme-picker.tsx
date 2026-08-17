"use client";

/**
 * ChatThemePicker — chooser for the chat surface theme.
 *
 * Two variants (mirrors AccentPicker):
 *  - "dropdown" (default): a trigger showing the active theme (mini preview) that
 *    opens a menu of all themes. Used on Settings → General.
 *  - "grid": a compact fixed-width preview grid with no nested popover. Used
 *    inside the ChatQuickSettings popover.
 *
 * Built-in themes always render. Community themes (fetched from the
 * cairn-community themes.json manifest) are appended under a "Community" group
 * when present.
 */

import React, { useEffect, useState } from "react";
import { ChevronsUpDown, Check, Loader2 } from "lucide-react";
import { useCairnStore } from "@/store";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import {
  CHAT_THEME_PRESETS,
  allChatThemes,
  resolveChatTheme,
  type ChatThemePreset,
} from "../../../shared/ui/chat-themes";
import { manifestToChatThemes } from "../../../shared/ui/chat-themes";

function useCommunityThemes(): { themes: ChatThemePreset[]; loaded: boolean } {
  const [extras, setExtras] = useState<ChatThemePreset[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const api = typeof window !== "undefined" ? window.electron?.registry : undefined;
      if (!api?.fetchChatThemes) return;
      try {
        // Cache-first for an instant paint, then ALWAYS background-refresh and
        // prefer the fresh manifest. This self-heals a stale cache (e.g. one
        // written with an older themes.json shape, whose entries parse to
        // nothing) AND surfaces newly-published community themes without a
        // manual refresh — the manifest is tiny, so the extra round-trip is
        // negligible.
        const cached = await api.fetchChatThemes();
        let manifest = cached?.manifest;
        try {
          const fresh = await api.refreshChatThemes?.();
          if (fresh?.manifest && fresh.manifest.themes.length > 0) {
            manifest = fresh.manifest;
          }
        } catch {
          /* soft — keep the cached result on a network failure */
        }
        if (!cancelled && manifest) {
          setExtras(manifestToChatThemes(manifest.themes));
        }
      } catch {
        /* soft — community themes are optional */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { themes: extras, loaded };
}

/** Mini chat preview (bg + user + AI bubble) for a theme. */
function ThemePreview({ theme, size = "md" }: { theme: ChatThemePreset; size?: "md" | "lg" }) {
  const isLight =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";
  const v = theme[isLight ? "light" : "dark"];
  const gradient = v.stops.length >= 2
    ? `linear-gradient(160deg, ${v.stops.join(", ")})`
    : v.bg;

  return (
    <span
      className={cn(
        "relative inline-flex flex-col gap-[3px] rounded-[7px] border border-[var(--border)] p-[3px] shrink-0",
        size === "lg" ? "w-16 h-12" : "w-10 h-8"
      )}
      style={{ background: gradient }}
    >
      <span
        className="self-start h-[6px] w-1/2 rounded-[3px] border"
        style={{ background: v.aiBubble, borderColor: "rgba(128,128,128,0.3)" }}
      />
      <span
        className="self-end h-[6px] w-1/2 rounded-[3px]"
        style={{ background: v.userBubble }}
      />
    </span>
  );
}

export function ChatThemePicker({
  variant = "dropdown",
  className,
}: {
  variant?: "dropdown" | "grid";
  className?: string;
}) {
  const chatTheme = useCairnStore((s) => s.chatTheme);
  const setChatTheme = useCairnStore((s) => s.setChatTheme);
  const { themes: community, loaded } = useCommunityThemes();
  const all = allChatThemes(community);
  const builtins = CHAT_THEME_PRESETS;
  const active = resolveChatTheme(chatTheme, community);

  const select = (id: string) => setChatTheme(id);

  if (variant === "grid") {
    return (
      <div
        className={cn(
          "grid grid-cols-3 place-items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2",
          className
        )}
      >
        {all.map((theme) => {
          const activeItem = chatTheme === theme.id;
          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => select(theme.id)}
              title={theme.name}
              aria-label={theme.name}
              aria-pressed={activeItem}
              className={cn(
                "relative transition-transform hover:scale-105 focus:outline-none rounded-[8px]",
                activeItem && "ring-2 ring-[var(--accent)]"
              )}
            >
              <ThemePreview theme={theme} />
            </button>
          );
        })}
        {!loaded && (
          <Loader2 size={12} className="animate-spin text-[var(--text-tertiary)] col-span-3 mt-0.5" />
        )}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Chat theme"
          className={cn(
            "flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]",
            "px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors",
            "hover:border-[var(--muted)] focus:outline-none",
            className
          )}
        >
          <ThemePreview theme={active} />
          <span className="flex-1 text-left">{active.name}</span>
          <ChevronsUpDown size={12} className="text-[var(--text-tertiary)]" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[240px] p-1 max-h-[360px] overflow-y-auto">
        {builtins.map((theme) => {
          const activeItem = chatTheme === theme.id;
          return (
            <DropdownMenuItem
              key={theme.id}
              onSelect={() => select(theme.id)}
              className={cn(activeItem && "text-[var(--text-primary)]")}
            >
              <ThemePreview theme={theme} />
              <span className="flex-1">{theme.name}</span>
              {activeItem && <Check size={12} className="text-[var(--accent)]" />}
            </DropdownMenuItem>
          );
        })}

        {community.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[0.643rem] text-[var(--text-tertiary)] px-2 py-1">
              Community
            </DropdownMenuLabel>
            {community.map((theme) => {
              const activeItem = chatTheme === theme.id;
              return (
                <DropdownMenuItem
                  key={theme.id}
                  onSelect={() => select(theme.id)}
                  className={cn(activeItem && "text-[var(--text-primary)]")}
                >
                  <ThemePreview theme={theme} />
                  <span className="flex-1">{theme.name}</span>
                  {activeItem && <Check size={12} className="text-[var(--accent)]" />}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
