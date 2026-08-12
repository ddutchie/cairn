"use client";

import React, { useState, useCallback, useContext, createContext } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FontScale } from "@/store/slices/ui";

// ── Step type ─────────────────────────────────────────────────────────────────

export type OnboardingStep =
  | "choose-folder"
  | "workspace-details"
  | "appearance"
  | "ai-setup"
  | "mcp"
  | "embeddings"
  | "views"
  | "create-project"
  | "imported-projects"
  | "done";

/** Steps that show the progress dots (post-workspace steps only). The
 *  create-project and imported-projects steps are mutually exclusive
 *  alternatives that occupy the SAME slot, so only create-project appears here;
 *  imported-projects is normalised to it in Shell. */
export const PROGRESS_STEPS: OnboardingStep[] = ["appearance", "ai-setup", "mcp", "embeddings", "views", "create-project", "done"];

// ── Font scale options ────────────────────────────────────────────────────────

export const FONT_OPTS: { value: FontScale; label: string; desc: string }[] = [
  { value: 1,   label: "XS", desc: "100%" },
  { value: 1.1, label: "S",  desc: "110%" },
  { value: 1.2, label: "M",  desc: "120%" },
  { value: 1.3, label: "L",  desc: "130%" },
  { value: 1.4, label: "XL", desc: "140%" },
];

// ── MCP agent configs ─────────────────────────────────────────────────────────

export const MCP_AGENTS = [
  {
    id: "claude",
    label: "Claude Desktop",
    icon: "✦",
    file: "~/Library/Application Support/Claude/claude_desktop_config.json",
    snippet: (bin: string) => `{\n  "mcpServers": {\n    "cairn": {\n      "command": "${bin}"\n    }\n  }\n}`,
  },
  {
    id: "opencode",
    label: "OpenCode",
    icon: "◈",
    file: ".opencode/config.json",
    snippet: (bin: string) =>
      `{\n  "mcp": {\n    "cairn": {\n      "type": "local",\n      "command": ["${bin}"],\n      "enabled": true\n    }\n  }\n}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    icon: "⌂",
    file: "~/.cursor/mcp.json",
    snippet: (bin: string) => `{\n  "mcpServers": {\n    "cairn": {\n      "command": "${bin}"\n    }\n  }\n}`,
  },
  {
    id: "cline",
    label: "Cline",
    icon: "⧉",
    file: "VS Code settings.json (via Cline extension)",
    snippet: (bin: string) => `{\n  "mcpServers": {\n    "cairn": {\n      "command": "${bin}"\n    }\n  }\n}`,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    icon: "◇",
    file: "~/.codeium/windsurf/mcp_config.json",
    snippet: (bin: string) => `{\n  "mcpServers": {\n    "cairn": {\n      "command": "${bin}"\n    }\n  }\n}`,
  },
] as const;

export type McpAgentId = (typeof MCP_AGENTS)[number]["id"];

// ── Nav footer context ────────────────────────────────────────────────────────
// Shell provides a fixed footer div outside the scrollable area. NavRow portals
// into it so the Back / Next buttons are always pinned at the bottom.

const NavFooterCtx = createContext<HTMLDivElement | null>(null);

// ── Shell layout ──────────────────────────────────────────────────────────────

export function Shell({
  children,
  step,
}: {
  children: React.ReactNode;
  step: OnboardingStep;
}) {
  // imported-projects is the vault-import alternative to create-project; it
  // shares the same progress slot.
  const progressStep = step === "imported-projects" ? "create-project" : step;
  const idx = PROGRESS_STEPS.indexOf(progressStep);
  const showProgress = idx >= 0;
  // useState (not useRef) so that NavRow re-renders when the footer mounts.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const footerCbRef = useCallback((node: HTMLDivElement | null) => setFooterEl(node), []);

  return (
    <NavFooterCtx.Provider value={footerEl}>
      <div className="flex flex-col items-center h-full w-full bg-[var(--background)]">
        {/* Wordmark + progress — pinned at top */}
        <div className="flex-shrink-0 pt-10 pb-2 text-center select-none px-6">
          <h1
            className="text-4xl font-semibold text-[var(--text-primary)] tracking-tight mb-1"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Cairn
          </h1>
          <p className="text-sm text-[var(--text-tertiary)]">Your personal knowledge base</p>

          {/* Progress dots */}
          {showProgress && (
            <div className="flex items-center justify-center gap-2 mt-6">
              {PROGRESS_STEPS.map((s, i) => (
                <div
                  key={s}
                  className={cn(
                    "rounded-full transition-all duration-200",
                    i === idx
                      ? "w-5 h-1.5 bg-[var(--accent)]"
                      : i < idx
                      ? "w-1.5 h-1.5 bg-[var(--accent)] opacity-40"
                      : "w-1.5 h-1.5 bg-[var(--border)]"
                  )}
                />
              ))}
            </div>
          )}
        </div>

        {/* Scrollable step content — grid centering avoids the justify-center
            overflow clipping bug (content no longer cut off at the top). */}
        <div className="flex-1 min-h-0 w-full overflow-y-auto">
          <div className="min-h-full grid place-items-center px-6 py-6">
            {children}
          </div>
        </div>

        {/* Fixed nav footer — NavRow portals into this */}
        <div
          ref={footerCbRef}
          className="flex-shrink-0 w-full max-w-md px-6 pb-6 pt-3 mx-auto bg-gradient-to-t from-[var(--background)] via-[var(--background)] to-transparent"
        />
      </div>
    </NavFooterCtx.Provider>
  );
}

// ── Nav row ───────────────────────────────────────────────────────────────────

export function NavRow({
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled = false,
  nextIcon,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextIcon?: React.ReactNode;
}) {
  const footerEl = useContext(NavFooterCtx);

  const content = (
    <div className={cn("flex items-center", onBack ? "justify-between" : "justify-end")}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] rounded-lg hover:bg-[var(--surface-2)] transition-colors"
        >
          <ArrowLeft size={12} />
          Back
        </button>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className={cn(
          "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all",
          nextDisabled
            ? "bg-[var(--surface-2)] text-[var(--text-tertiary)] cursor-not-allowed"
            : "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
        )}
      >
        {nextLabel}
        {nextIcon ?? <ArrowRight size={13} />}
      </button>
    </div>
  );

  // Portal into Shell's fixed footer slot; fall back to inline rendering
  if (footerEl) {
    return createPortal(content, footerEl);
  }
  return <div className="mt-5">{content}</div>;
}

