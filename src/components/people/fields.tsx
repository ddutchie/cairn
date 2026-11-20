"use client";

/**
 * Edit-form pieces shared by the person page and the team page: a labelled
 * row and a one-line input that saves on blur or Enter.
 */
import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { MicroLabel } from "@/components/ui/labels";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 @md:grid-cols-[9rem_1fr] items-start gap-x-3 gap-y-1 py-2 border-b border-[var(--border-subtle)] last:border-0">
      <MicroLabel className="@md:pt-1.5 text-xs">{label}</MicroLabel>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * A text input that saves on blur or Enter. Callers key it by the saved value
 * (see BlurInput), so a save or an outside change starts a fresh draft.
 */
export function DraftInput({ value, onSave, placeholder, ariaLabel }: {
  value: string; onSave: (v: string) => void; placeholder?: string; ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className="text-xs"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/** {@link DraftInput} keyed by the saved value, so a save or an outside change starts a fresh draft. */
export function BlurInput(props: React.ComponentProps<typeof DraftInput>) {
  return <DraftInput key={props.value} {...props} />;
}
