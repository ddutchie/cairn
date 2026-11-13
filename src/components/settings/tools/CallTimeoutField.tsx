"use client";

import { useId } from "react";
import { DEFAULT_CALL_TIMEOUT_SEC, MAX_CALL_TIMEOUT_SEC, MIN_CALL_TIMEOUT_SEC } from "../../../../shared/types/tools";
import { cn } from "@/lib/utils";
import { inputCls, labelCls } from "./helpers";

/** Per-connector limit for one tool call, in seconds; empty means the default. */
export function CallTimeoutField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div>
      <label htmlFor={inputId} className={labelCls}>Call timeout in seconds (optional)</label>
      <input
        id={inputId}
        aria-describedby={hintId}
        type="number"
        min={MIN_CALL_TIMEOUT_SEC}
        max={MAX_CALL_TIMEOUT_SEC}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={String(DEFAULT_CALL_TIMEOUT_SEC)}
        className={cn(inputCls, "font-mono")}
      />
      <p id={hintId} className="mt-1 text-xs text-[var(--text-tertiary)]">
        How long one call may run before Cairn cancels it. Raise it for a connector that does slow work, such as running its own model. Leave empty for {DEFAULT_CALL_TIMEOUT_SEC / 60} minutes.
      </p>
    </div>
  );
}
