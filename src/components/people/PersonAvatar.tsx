"use client";

/**
 * A person's initials in a circle, and a stack of them for a group. Neutral on
 * purpose: colour in Cairn carries status, so "you" is the only accented face.
 */
import React from "react";
import { cn } from "@/lib/utils";

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  // By character, not UTF-16 unit, so a name starting with a supplementary character isn't cut in half.
  const letter = (part: string) => Array.from(part)[0] ?? "";
  const first = letter(parts[0]);
  const last = parts.length > 1 ? letter(parts[parts.length - 1]) : "";
  return (first + last).toUpperCase();
}

const SIZE = {
  xs: "size-5 text-2xs",
  sm: "size-6 text-2xs",
  md: "size-8 text-xs",
} as const;

export function PersonAvatar({ name, isMe = false, size = "sm", className }: {
  name: string; isMe?: boolean; size?: keyof typeof SIZE; className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center rounded-full font-medium tabular-nums select-none",
        SIZE[size],
        isMe
          ? "bg-[var(--accent-dim)] text-[var(--accent)]"
          : "bg-[color-mix(in_srgb,var(--text-primary)_13%,var(--surface-2))] text-[var(--text-secondary)]",
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Overlapping avatars, up to `max`, then "+N". The names are for assistive tech. */
export function AvatarStack({ people, max = 7, size = "sm" }: {
  people: readonly { id: string; name: string; isMe?: boolean }[]; max?: number; size?: keyof typeof SIZE;
}) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className="inline-flex items-center" role="img" aria-label={people.map((p) => p.name).join(", ")}>
      {shown.map((p, i) => (
        <PersonAvatar key={p.id} name={p.name} isMe={p.isMe} size={size} className={cn("ring-2 ring-[var(--surface-2)]", i > 0 && "-ml-1")} />
      ))}
      {more > 0 && <span className="ml-1.5 text-2xs text-[var(--text-tertiary)] tabular-nums">+{more}</span>}
    </span>
  );
}
