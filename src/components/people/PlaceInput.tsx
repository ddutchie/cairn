"use client";

/**
 * A text field for a place or a time zone with suggestions as you type: cities
 * (from the city data, biggest first) and, for a time zone, IANA zone names.
 * Free text still works: Enter or leaving the field saves what was typed, and
 * the caller validates it. Picking a suggestion saves at once.
 */
import React, { useId, useMemo, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { searchPlaces, searchZones } from "../../../shared/people/place-zone";

export type PlaceInputMode = "location" | "timezone";

interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  /** What to save, and for a location the zone it implies. */
  text: string;
  zone?: string;
}

function suggestionsFor(mode: PlaceInputMode, query: string): Suggestion[] {
  const cities = searchPlaces(query);
  if (mode === "location") return cities.map((c) => ({ key: c.label, label: c.label, detail: c.zone, text: c.label, zone: c.zone }));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const z of searchZones(query)) { seen.add(z); out.push({ key: `z:${z}`, label: z, text: z }); }
  for (const c of cities) {
    if (seen.has(c.zone)) continue;
    seen.add(c.zone);
    out.push({ key: `c:${c.label}`, label: c.zone, detail: c.label, text: c.zone });
  }
  return out.slice(0, 8);
}

export function PlaceInput({ value, mode, ariaLabel, placeholder, onCommit }: {
  value: string;
  mode: PlaceInputMode;
  ariaLabel: string;
  placeholder?: string;
  /** Typed text on Enter or blur, or a picked suggestion (with the zone it implies). */
  onCommit: (text: string, zone?: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const suggestions = useMemo(() => (focused ? suggestionsFor(mode, draft) : []), [focused, mode, draft]);
  const open = focused && !dismissed && suggestions.length > 0 && draft.trim() !== value;
  const current = open ? suggestions[Math.min(active, suggestions.length - 1)] : undefined;
  const optionId = (i: number) => `${listId}-${i}`;

  const pick = (s: Suggestion) => {
    setDraft(s.text);
    setDismissed(true);
    onCommit(s.text, s.zone);
  };

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <Input
          value={draft}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(suggestions.indexOf(current)) : undefined}
          placeholder={placeholder}
          className="text-xs"
          onChange={(e) => { setDraft(e.target.value); setDismissed(false); setActive(0); }}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); if (draft !== value) onCommit(draft); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
            } else if (e.key === "Enter") {
              if (current) { e.preventDefault(); pick(current); } else (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              setDismissed(true);
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        matchTriggerWidth
        className="max-h-64 overflow-y-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => { if ((e.target as HTMLElement | null)?.closest?.("input[role=combobox]")) e.preventDefault(); }}
      >
        <ul id={listId} role="listbox" aria-label={`${ariaLabel} suggestions`}>
          {suggestions.map((s, i) => (
            <li
              key={s.key} id={optionId(i)} role="option" aria-selected={s === current}
              // Keep focus in the field: a mouse press here must not blur it before the pick lands.
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-baseline justify-between gap-3 rounded px-2 py-1.5 text-xs", s === current ? "bg-[var(--accent-dim)] text-[var(--text-primary)]" : "text-[var(--text-secondary)]")}
            >
              <span className="min-w-0 truncate">{s.label}</span>
              {s.detail && <span className="flex-shrink-0 text-2xs text-[var(--text-tertiary)]">{s.detail}</span>}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
