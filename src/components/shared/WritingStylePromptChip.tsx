"use client";

/**
 * WritingStylePromptChip — rendered when the model calls
 * `get_user_writing_style` but no writing style is configured yet. The tool
 * succeeds and reports `configured: false`, so the normal success chip would
 * hide that the user's voice can't be matched. This chip surfaces it with a
 * "Set up writing style" action that pops the wizard modal directly.
 *
 * Shared by Chat and Coding tool renderers, mirroring cairn-ref-chip.
 */

import { useState } from "react";
import { PenLine } from "lucide-react";
import { UserStyleWizardModal } from "@/components/settings/UserStyleWizardModal";

/**
 * True when a `get_user_writing_style` tool output signals that no writing
 * style is configured (the tool returns `{ configured: false, ... }`).
 */
export function writingStyleNeedsSetup(output?: string): boolean {
  if (!output) return false;
  try {
    const parsed = JSON.parse(output) as { configured?: unknown };
    return parsed?.configured === false;
  } catch {
    return false;
  }
}

export function WritingStylePromptChip({ output }: { output?: string }) {
  const [open, setOpen] = useState(false);
  if (!writingStyleNeedsSetup(output)) return null;
  return (
    <>
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] border border-[var(--accent)] w-fit max-w-full"
        data-testid="writing-style-prompt-chip"
      >
        <PenLine size={11} className="text-[var(--accent)] shrink-0" />
        <span className="text-[0.786rem] text-[var(--text-secondary)]">No writing style set up — the AI can&apos;t match your voice yet.</span>
        <button
          onClick={() => setOpen(true)}
          className="text-[0.714rem] font-medium text-[var(--accent)] hover:underline shrink-0 cursor-pointer"
        >
          Set up writing style
        </button>
      </div>
      {open && <UserStyleWizardModal onClose={() => setOpen(false)} />}
    </>
  );
}
