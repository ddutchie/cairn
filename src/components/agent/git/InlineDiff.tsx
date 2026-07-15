"use client";

import { useMemo } from "react";
import parseDiff from "parse-diff";
import { useIsDark } from "@/hooks/useIsDark";
import { UnifiedFile, PALETTE_DARK, PALETTE_LIGHT } from "../DiffFile";

/** Renders a raw unified-diff string as themed diff hunks (or a loading/empty note). */
export function InlineDiff({ rawDiff, loading }: { rawDiff: string; loading: boolean }) {
  const isDark = useIsDark();
  const palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;

  const parsed = useMemo(() => {
    if (!rawDiff) return [];
    try { return parseDiff(rawDiff); } catch { return []; }
  }, [rawDiff]);

  if (loading) {
    return (
      <div className="px-10 py-2 text-[0.65rem] text-[var(--text-tertiary)]">
        Loading diff...
      </div>
    );
  }
  if (parsed.length === 0) {
    return (
      <div className="px-10 py-2 text-[0.65rem] text-[var(--text-tertiary)]">
        No diff content
      </div>
    );
  }
  return (
    <div className="border-y border-[var(--border-subtle)]">
      {parsed.map((file, i) => (
        <UnifiedFile
          key={file.to ?? file.from ?? i}
          file={file}
          palette={palette}
          changesOnly={false}
          hunkTop={0}
        />
      ))}
    </div>
  );
}
