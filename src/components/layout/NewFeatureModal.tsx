"use client";

import React, { useState } from "react";
import { Sparkles, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { NEW_FEATURES_REGISTRY } from "@/lib/new-features-registry";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";

interface Props {
  forceOpen?: boolean;
  onClose?: () => void;
}

export function NewFeatureModal({ forceOpen = false, onClose }: Props) {
  const { seenFeatures, markFeatureAsSeen } = useCairnStore(
    useShallow((s) => ({
      seenFeatures: s.seenFeatures,
      markFeatureAsSeen: s.markFeatureAsSeen,
    }))
  );

  // Determine which features to highlight.
  // If forceOpen (e.g. from Settings), show all features in the registry.
  // Otherwise, show only unseen features belonging to the latest version.
  const featuresToShow = React.useMemo(() => {
    if (forceOpen) {
      return NEW_FEATURES_REGISTRY;
    }
    if (NEW_FEATURES_REGISTRY.length === 0) return [];
    const latestVersion = NEW_FEATURES_REGISTRY[NEW_FEATURES_REGISTRY.length - 1].version;
    return NEW_FEATURES_REGISTRY.filter((f) => f.version === latestVersion && !seenFeatures.includes(f.id));
  }, [forceOpen, seenFeatures]);

  const [activeIdx, setActiveIdx] = useState(0);
  const [prevFeaturesLength, setPrevFeaturesLength] = useState(featuresToShow.length);

  // Derive the open state from props/seen-features rather than syncing via setState in an effect.
  // The modal is open when forced by the parent, or when there are unseen features in the latest version.
  // Closing happens by marking features as seen (which empties featuresToShow) or the parent flipping forceOpen.
  const isOpen = forceOpen || featuresToShow.length > 0;

  // Reset the active index when the feature list changes (adjust during render to avoid cascading renders)
  if (prevFeaturesLength !== featuresToShow.length) {
    setPrevFeaturesLength(featuresToShow.length);
    if (activeIdx !== 0) {
      setActiveIdx(0);
    }
  }

  if (!isOpen || featuresToShow.length === 0) return null;

  const currentFeature = featuresToShow[activeIdx];
  const isLast = activeIdx === featuresToShow.length - 1;

  const handleNext = () => {
    if (!isLast) {
      setActiveIdx((prev) => prev + 1);
    } else {
      handleClose();
    }
  };

  const handlePrev = () => {
    if (activeIdx > 0) {
      setActiveIdx((prev) => prev - 1);
    }
  };

  const handleClose = () => {
    // Mark all currently displayed features as seen
    featuresToShow.forEach((f) => {
      markFeatureAsSeen(f.id);
    });
    if (onClose) {
      onClose();
    }
  };

  return (
    <ModalShell
      open={isOpen}
      onClose={handleClose}
      size="lg"
      scrollable={true}
      title={
        <div className="flex items-center gap-2 text-[var(--accent)] font-semibold">
          <Sparkles size={16} className="animate-pulse" />
          <span>What&apos;s New in Cairn</span>
          <span className="text-[0.714rem] px-2 py-0.5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_20%,transparent)] ml-2">
            {currentFeature.version}
          </span>
        </div>
      }
      footer={
        <div className="flex items-center justify-between w-full">
          {/* Pagination indicators */}
          {featuresToShow.length > 1 ? (
            <div className="flex items-center gap-1">
              {featuresToShow.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setActiveIdx(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                    i === activeIdx
                      ? "bg-[var(--accent)] w-3"
                      : "bg-[var(--border)] hover:bg-[var(--text-tertiary)]"
                  }`}
                  aria-label={`Go to feature ${i + 1}`}
                />
              ))}
            </div>
          ) : (
            <div />
          )}

          {/* Nav buttons */}
          <div className="flex items-center gap-2">
            {!isLast && featuresToShow.length > 1 && (
              <button
                onClick={handleClose}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors cursor-pointer mr-1"
              >
                Skip All
              </button>
            )}
            {featuresToShow.length > 1 && (
              <button
                onClick={handlePrev}
                disabled={activeIdx === 0}
                className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} />
              </button>
            )}
            <button
              onClick={handleNext}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-[var(--accent-fg)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors cursor-pointer"
            >
              <span>{isLast ? "Done" : "Next Feature"}</span>
              {isLast ? <Check size={13} /> : <ChevronRight size={13} />}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4 overflow-hidden">
        {/* Feature content info */}
        <div className="space-y-3 px-1">
          <div>
            <span className="text-[0.714rem] font-bold uppercase tracking-wider text-[var(--accent)]">
              {currentFeature.category}
            </span>
            <h2 className="text-base font-bold text-[var(--text-primary)] leading-tight mt-0.5">
              {currentFeature.title}
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">
              {currentFeature.description}
            </p>
          </div>

          {/* Bullet highlights list */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)] p-4 space-y-3">
            <h4 className="text-[0.714rem] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
              Key Highlights
            </h4>
            <ul className="space-y-2.5">
              {currentFeature.highlights.map((h, idx) => {
                // If it contains a colon, bold the prefix
                const colonIdx = h.indexOf(":");
                if (colonIdx !== -1) {
                  const prefix = h.substring(0, colonIdx);
                  const suffix = h.substring(colonIdx);
                  return (
                    <li key={idx} className="flex items-start gap-2.5 text-xs text-[var(--text-secondary)] leading-relaxed">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
                      <span>
                        <strong className="text-[var(--text-primary)] font-medium">{prefix}</strong>
                        {suffix}
                      </span>
                    </li>
                  );
                }
                return (
                  <li key={idx} className="flex items-start gap-2.5 text-xs text-[var(--text-secondary)] leading-relaxed">
                    <span className="mt-1 w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
                    <span>{h}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
