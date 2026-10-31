"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { WorkPhase } from "@/lib/conversation/work-phase";
import { Spinner } from "./spinner";

const ACCENT = "var(--accent)";

type LoaderCtor = (typeof import("loadersz/working"))["LoaderszLoader"];

/**
 * One canvas animation per phase, each loaded on demand (a single state is about 4 kB gzipped,
 * so only the phases a session actually reaches are ever downloaded). The states are the
 * ones that stay readable at chat-text size; the sparse dot fields don't.
 */
const LOADERS: Record<WorkPhase, () => Promise<{ LoaderszLoader: LoaderCtor }>> = {
  sending: () => import("loadersz/rendering"),
  thinking: () => import("loadersz/scanning"),
  responding: () => import("loadersz/typing"),
  tools: () => import("loadersz/prioritizing"),
  working: () => import("loadersz/marqueeing"),
  retrying: () => import("loadersz/retrying"),
  compacting: () => import("loadersz/summarizing"),
  waiting: () => import("loadersz/waiting"),
};

interface WorkLoaderProps {
  phase: WorkPhase;
  /** Square side in CSS pixels. */
  size?: number;
  className?: string;
}

/**
 * Animated activity indicator for a turn in flight. Drawn in the accent colour; falls back to
 * the plain spinner if the loader can't start (no canvas, failed chunk).
 */
export function WorkLoader({ phase, size = 16, className }: WorkLoaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Per phase, so one state failing to load doesn't leave the spinner up for every later phase.
  const [failedPhase, setFailedPhase] = useState<WorkPhase | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let loader: InstanceType<LoaderCtor> | undefined;
    LOADERS[phase]()
      .then(({ LoaderszLoader }) => {
        if (cancelled) return;
        loader = new LoaderszLoader(canvas, { size, color: ACCENT });
      })
      .catch(() => { if (!cancelled) setFailedPhase(phase); });
    // The accent is resolved once per setOptions, so re-apply it when the theme or accent changes.
    const recolor = new MutationObserver(() => loader?.setOptions({ size, color: ACCENT }));
    recolor.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    return () => { cancelled = true; recolor.disconnect(); loader?.destroy(); };
  }, [phase, size]);

  if (failedPhase === phase) return <Spinner size={size} tone="accent" className={className} />;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-work-phase={phase}
      className={cn("inline-block shrink-0 align-middle", className)}
      style={{ width: size, height: size }}
    />
  );
}
