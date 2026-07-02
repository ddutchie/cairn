"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with an auto-resetting "copied" flag. Consolidates the
 * `setCopied(true); setTimeout(() => setCopied(false), 2000)` idiom that was
 * duplicated across many components (with inconsistent reset delays).
 *
 * Boolean usage (single copy target):
 *   const { copied, copy } = useCopyToClipboard();
 *   <button onClick={() => copy(text)}>{copied ? "Copied" : "Copy"}</button>
 *
 * Keyed usage (several copy targets sharing one hook):
 *   const { copiedKey, copy, isCopied } = useCopyToClipboard();
 *   <button onClick={() => copy(a, "a")}>{isCopied("a") ? "Copied" : "Copy"}</button>
 *   <button onClick={() => copy(b, "b")}>{isCopied("b") ? "Copied" : "Copy"}</button>
 */
export function useCopyToClipboard(resetMs = 2000) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(
    async (text: string, key = "__default__") => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopiedKey(key);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCopiedKey(null);
        timerRef.current = null;
      }, resetMs);
      return true;
    },
    [resetMs],
  );

  const isCopied = useCallback((key: string) => copiedKey === key, [copiedKey]);

  return {
    /** True when the most recent copy (default key) is still within the reset window. */
    copied: copiedKey === "__default__",
    /** The key of the most recently copied target, or null. */
    copiedKey,
    /** True when a specific keyed target was most recently copied. */
    isCopied,
    /** Copy `text`; optionally tag it with `key` for keyed usage. */
    copy,
  };
}
