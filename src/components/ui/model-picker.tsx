"use client";

import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import {
  ChevronDown, RefreshCw, Check, Pencil, Star, Search, TriangleAlert,
  Type, Image as ImageIcon, FileText, Video, AudioLines,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Tooltip } from "@/components/ui/tooltip";
import {
  getModelInfo,
  getModelCatalogVersion,
  modelLogoUrl,
  prewarmModelCatalog,
  subscribeModelCatalog,
} from "@/lib/models-dev";
import {
  formatModelCost,
  modelInputChips,
  type ModelInfo,
} from "../../../shared/models/model-catalog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown";

/**
 * A single-line, truncated label that shows the app Tooltip with the full text
 * ONLY when the text is actually cut off (scrollWidth > clientWidth). Avoids a
 * pointless tooltip on names that already fit.
 */
export function TruncatedModel({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollWidth > el.clientWidth);
  }, [text]);

  const span = (
    <span ref={ref} className={cn("truncate block min-w-0 flex-1", className)}>
      {text}
    </span>
  );

  if (!overflowing) return span;
  return (
    <Tooltip content={text} side="top">
      {span}
    </Tooltip>
  );
}

/**
 * Input-capability icons for a model — the input modalities models.dev lists
 * for the model (e.g. Type / Image / FileText / Video / AudioLines). Renders
 * nothing when the catalog hasn't loaded or the model is unknown.
 */
const MODE_ICONS: Record<string, LucideIcon> = {
  text: Type,
  image: ImageIcon,
  pdf: FileText,
  video: Video,
  audio: AudioLines,
};

function CapabilityChips({ info }: { info: ModelInfo | null }) {
  const chips = modelInputChips(info);
  if (chips.length === 0) return null;
  return (
    <span className="flex items-center gap-0.5 flex-shrink-0">
      {chips.map((c) => {
        const Icon = MODE_ICONS[c.key];
        if (!Icon) return null;
        return (
          <Tooltip key={c.key} content={c.title}>
            <span className="text-[var(--text-tertiary)]">
              <Icon size={9} strokeWidth={1.75} />
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}

export interface ModelPickerProps {
  value: string;
  options: string[];
  loading: boolean;
  errored: boolean;
  disabled?: boolean;
  placeholder?: string;
  onChange: (model: string) => void;
  onRefresh: () => void;
  /** Visual density. "sm" = compact (chat popover); "md" = settings-row size. */
  size?: "sm" | "md";
  /** Dropdown alignment (default "start"). */
  align?: "start" | "center" | "end";
  className?: string;
}

/**
 * Model selector used across the app (chat quick-settings popover + settings
 * endpoint rows + saved-provider form). Uses the shared Radix dropdown for a
 * consistent floating panel + click-away, listing the endpoint's fetched models
 * with a Refresh action to re-query and a "Custom model…" affordance for typing
 * any model id the endpoint didn't list.
 */
export function ModelPicker({
  value,
  options,
  loading,
  errored,
  disabled,
  placeholder,
  onChange,
  onRefresh,
  size = "sm",
  align = "start",
  className,
}: ModelPickerProps) {
  // Custom-entry mode: a free-text input for a model id not in the list.
  const [custom, setCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (custom) customRef.current?.focus(); }, [custom]);

  // Search filter over the model list (reset each time the menu re-opens).
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Re-render rows once the models.dev catalog finishes loading in the
  // background so cost / logo / tool markers can appear (see ModelRow).
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);

  const { favoriteModels, toggleFavoriteModel } = useCairnStore(
    useShallow((s) => ({ favoriteModels: s.favoriteModels, toggleFavoriteModel: s.toggleFavoriteModel })),
  );

  // Filter by query, then split into favorites-first sections. Favorites keep
  // their original list order; non-favorites follow. The active value always
  // stays reachable even if it isn't in the fetched list.
  const { favs, rest } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? options.filter((m) => m.toLowerCase().includes(q)) : options;
    const favs: string[] = [];
    const rest: string[] = [];
    for (const m of filtered) (favoriteModels.has(m) ? favs : rest).push(m);
    return { favs, rest };
  }, [options, query, favoriteModels]);

  const noMatches = query.trim() !== "" && favs.length === 0 && rest.length === 0;

  // Enrichment for the closed trigger (logo + cost + tool marker), same as rows.
  const triggerInfo = getModelInfo(value);
  const triggerLogo = modelLogoUrl(value);
  const triggerCost = formatModelCost(triggerInfo?.input ?? null, triggerInfo?.output ?? null);
  const triggerNoToolCall = triggerInfo?.toolCall === false;

  useEffect(() => { prewarmModelCatalog(); }, []);

  const triggerPad = size === "md" ? "px-2.5 py-1.5 text-xs" : "px-2 py-1 text-[0.714rem]";

  if (custom) {
    return (
      <div className={cn("flex gap-1", className)}>
        <input
          ref={customRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setCustom(false); }}
          disabled={disabled}
          placeholder={placeholder}
          className={cn(
            "flex-1 min-w-0 font-mono rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50",
            triggerPad,
          )}
        />
        <Tooltip content="Done" side="top">
          <button
            onClick={() => setCustom(false)}
            className="flex items-center justify-center px-1.5 rounded-md border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--surface-3)] transition-colors"
          >
            <Check size={12} />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={cn("flex gap-1", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            className={cn(
              "flex-1 min-w-0 flex items-center justify-between gap-1 rounded-md border bg-[var(--surface-2)] text-[var(--text-primary)] transition-colors disabled:opacity-50",
              triggerPad,
              errored ? "border-[var(--danger)]" : "border-[var(--border)] hover:border-[var(--muted)]",
            )}
          >
            {value ? (
              <>
                {triggerLogo && (
                  <img
                    src={triggerLogo}
                    alt=""
                    className="provider-logo h-3 w-3 rounded-[2px] object-contain flex-shrink-0"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                )}
                <TruncatedModel text={value} className="font-mono" />
                <CapabilityChips info={triggerInfo} />
                {triggerNoToolCall && (
                  <Tooltip content="This model doesn't support tool calling">
                    <span className="flex-shrink-0 text-[var(--warning)]">
                      <TriangleAlert size={11} />
                    </span>
                  </Tooltip>
                )}
                {triggerCost && (
                  <span className="text-[0.607rem] tabular-nums text-[var(--text-tertiary)] flex-shrink-0">
                    {triggerCost}
                  </span>
                )}
              </>
            ) : (
              <span className="truncate font-sans text-[var(--text-tertiary)]">
                {placeholder || "Select model"}
              </span>
            )}
            <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          className="max-w-[260px] w-[240px] max-h-72 overflow-y-auto"
          onCloseAutoFocus={() => setQuery("")}
          onOpenAutoFocus={(e: Event) => {
            e.preventDefault();
            prewarmModelCatalog();
            requestAnimationFrame(() => searchRef.current?.focus());
          }}
        >
          {/* Search box — filters the list below. Kept out of the scrollable rows
              so it stays pinned while scrolling. stopPropagation prevents Radix's
              typeahead from hijacking keystrokes. */}
          <div className="sticky top-0 z-10 bg-[var(--surface-1)] px-1 pt-1 pb-1.5">
            <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1">
              <Search size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search models…"
                className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
              />
            </div>
          </div>

          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); onRefresh(); }}
            className="text-[var(--text-secondary)]"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading ? "Refreshing…" : "Refresh models"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCustom(true)}>
            <Pencil size={12} />
            Custom model…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {errored && (
            <div className="px-2.5 py-1.5 text-[0.643rem] text-[var(--danger)]">
              Couldn&apos;t load models — check the endpoint.
            </div>
          )}
          {options.length === 0 && !errored && (
            <div className="px-2.5 py-1.5 text-[0.643rem] text-[var(--text-tertiary)]">
              No models — Refresh or add a custom one.
            </div>
          )}
          {noMatches && (
            <div className="px-2.5 py-1.5 text-[0.643rem] text-[var(--text-tertiary)]">
              No models match &ldquo;{query.trim()}&rdquo;.
            </div>
          )}
          {favs.length > 0 && (
            <>
              <div className="px-2.5 pt-1 pb-0.5 text-[0.607rem] uppercase tracking-wide text-[var(--text-tertiary)]">
                Favorites
              </div>
              {favs.map((m) => (
                <ModelRow
                  key={m}
                  model={m}
                  active={m === value}
                  favorite
                  onSelect={() => onChange(m)}
                  onToggleFavorite={() => toggleFavoriteModel(m)}
                />
              ))}
              {rest.length > 0 && <DropdownMenuSeparator />}
            </>
          )}
          {rest.map((m) => (
            <ModelRow
              key={m}
              model={m}
              active={m === value}
              favorite={false}
              onSelect={() => onChange(m)}
              onToggleFavorite={() => toggleFavoriteModel(m)}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * A single model row inside the picker: a favorite star (toggles without closing
 * the menu), the active-check gutter, and the truncated model id. Selecting the
 * row picks the model; clicking the star only toggles the favorite.
 *
 * When the models.dev catalog is loaded, the row is enriched with the provider
 * logo, a compact per-1M cost (`$in/$out`), and a warning marker when the model
 * is known not to support tool calls. Catalog data is best-effort — rows render
 * fine without it.
 */
function ModelRow({
  model,
  active,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  model: string;
  active: boolean;
  favorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  const info = getModelInfo(model);
  const logo = modelLogoUrl(model);
  const cost = formatModelCost(info?.input ?? null, info?.output ?? null);
  const noToolCall = info?.toolCall === false;

  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn("group gap-1.5 font-mono text-xs", active && "text-[var(--accent)]")}
    >
      <button
        type="button"
        aria-label={favorite ? "Unfavorite model" : "Favorite model"}
        title={favorite ? "Unfavorite" : "Favorite"}
        // Radix Menu.Item triggers selection on pointerup / click. Stop those
        // events at the star so tapping it only toggles the favorite instead of
        // selecting the model and closing the menu. (Don't preventDefault on
        // pointerdown — that would suppress the follow-up click in some engines.)
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFavorite(); }}
        className={cn(
          "flex-shrink-0 flex items-center justify-center rounded p-0.5 -ml-0.5 transition-colors",
          favorite
            ? "text-[var(--accent)] hover:text-[var(--text-tertiary)]"
            : "text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 hover:text-[var(--accent)]",
        )}
      >
        <Star size={12} className={favorite ? "fill-current" : ""} />
      </button>
      {active && <Check size={12} className="flex-shrink-0" />}
      {logo && (
        <img
          src={logo}
          alt=""
          className="provider-logo h-3 w-3 rounded-[2px] object-contain flex-shrink-0"
          // Some provider slugs 404 — drop the broken glyph rather than showing it.
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <TruncatedModel text={model} />
      <CapabilityChips info={info} />
      {noToolCall && (
        <Tooltip content="This model doesn't support tool calling">
          <span className="flex-shrink-0 text-[var(--warning)]">
            <TriangleAlert size={12} />
          </span>
        </Tooltip>
      )}
      {cost && (
        <span className="ml-auto pl-2 text-[0.607rem] tabular-nums text-[var(--text-tertiary)] flex-shrink-0">
          {cost}
        </span>
      )}
    </DropdownMenuItem>
  );
}
