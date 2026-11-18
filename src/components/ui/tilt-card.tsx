
"use client";

import React, { useState, useRef, useEffect, useCallback, type ReactNode } from "react";

/** Hover lift + 3D tilt for an Overview card, following the pointer. */
export function useTilt(targetRef: React.RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState(false);
  const [transform, setTransform] = useState<React.CSSProperties>({});
  const raf = useRef<number | null>(null);
  const onMove = useCallback((e: React.MouseEvent) => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = targetRef.current;
    if (!el) return;
    const { clientX, clientY } = e;
    setActive(true);
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const rx = ((clientY - r.top - r.height / 2) / (r.height / 2)) * -2.2;
      const ry = ((clientX - r.left - r.width / 2) / (r.width / 2)) * 2.8;
      setTransform({ transform: `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) scale(1.012)`, transition: "transform 0.08s linear" });
    });
  }, [targetRef]);
  const onLeave = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    setActive(false);
    setTransform({ transform: "perspective(900px) rotateX(0) rotateY(0) scale(1)", transition: "transform 0.55s cubic-bezier(.23,1,.32,1)" });
  }, []);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  return { transform, onMove, onLeave, active };
}

/**
 * A card that lifts and tilts toward the pointer. Pass the resting and hover
 * box-shadows, or `dropShadow` for content without a box (the radar SVG).
 */
export function TiltCard({ className, restShadow, activeShadow, dropShadow, children }: {
  className?: string;
  restShadow?: string;
  activeShadow?: string;
  /** CSS `filter` drop-shadow applied while hovered, instead of box-shadows. */
  dropShadow?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tilt = useTilt(ref);
  return (
    <div
      ref={ref}
      onMouseMove={tilt.onMove}
      onMouseLeave={tilt.onLeave}
      className={className}
      style={{
        willChange: tilt.active ? "transform" : undefined,
        ...(dropShadow
          ? { filter: tilt.active ? dropShadow : undefined }
          : { boxShadow: tilt.active ? activeShadow : restShadow }),
        ...tilt.transform,
      }}
    >
      {children}
    </div>
  );
}
