"use client";

import React from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared UI primitives used across the Project Overview sections.

export function SectionHeader({
  title, icon, action,
}: {
  title: string;
  icon: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-1.5 text-[0.786rem] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
        {icon}{title}
      </div>
      {action && (
        <button onClick={action.onClick}
          className="text-[0.786rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1">
          {action.label}<ArrowRight size={10} />
        </button>
      )}
    </div>
  );
}

/**
 * A section with a click-to-toggle header. Collapsing keeps the title row
 * (with its action) and swaps the body for a compact one-line {@link collapsedView}
 * so the section stays glanceable instead of vanishing. Presentational — the
 * parent owns the collapsed state.
 */
export function CollapsibleSection({
  title, icon, action, collapsed, onToggle, collapsedView, children,
}: {
  title: string;
  icon: React.ReactNode;
  action?: { label: string; onClick: () => void };
  collapsed: boolean;
  onToggle: () => void;
  /** Slim representation shown while collapsed (e.g. a segmented health bar). */
  collapsedView?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          className="flex items-center gap-1 text-[0.786rem] font-semibold text-[var(--text-secondary)] uppercase tracking-wider hover:text-[var(--text-primary)] transition-colors group cursor-pointer"
        >
          <ChevronDown size={11} className={cn("text-[var(--text-tertiary)] transition-transform", collapsed && "-rotate-90")} />
          <span className="group-hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5">
            {icon}{title}
          </span>
        </button>
        {action && (
          <button onClick={action.onClick}
            className="text-[0.786rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1">
            {action.label}<ArrowRight size={10} />
          </button>
        )}
      </div>
      {collapsed
        ? (collapsedView ?? null)
        : <div>{children}</div>}
    </section>
  );
}

export function StatCard({
  icon, iconColor, iconBg, value, label, valueColor, danger, onClick,
}: {
  icon: React.ReactNode; iconColor: string; iconBg: string;
  value: number; label: string; valueColor?: string; danger?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className={cn("p-4 rounded-xl border bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors text-left flex items-center gap-3 group",
        danger ? "border-[var(--danger)]/25" : "border-[var(--border)]")}>
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: iconBg, color: iconColor }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold leading-none" style={{ color: valueColor ?? "var(--text-primary)" }}>{value}</div>
        <div className="text-[0.786rem] text-[var(--text-tertiary)] mt-1">{label}</div>
      </div>
      <ArrowRight size={11} className="ml-auto text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  );
}

export function ProgressRing({ percent, size }: { percent: number; size: number }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDash = circumference - (percent / 100) * circumference;
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} stroke="var(--border)" strokeWidth="4" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={radius} stroke="var(--accent)" strokeWidth="4" fill="none"
        strokeDasharray={circumference} strokeDashoffset={strokeDash} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }} />
      <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle"
        style={{ transform: "rotate(90deg)", transformOrigin: "50% 50%", fontSize: 11, fontWeight: 700, fill: "var(--text-primary)" }}>
        {percent}%
      </text>
    </svg>
  );
}
