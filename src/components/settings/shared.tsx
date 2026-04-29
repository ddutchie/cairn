"use client";

import React from "react";
import { cn } from "@/lib/utils";

// ── Layout helpers ────────────────────────────

export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
        {description && (
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-[var(--border-subtle)]">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-secondary)]">{label}</div>
        {description && (
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// ── Toggle switch ─────────────────────────────

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
        checked ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
      )}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface)] shadow-sm transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
