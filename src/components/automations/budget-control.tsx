"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown";

interface BudgetState {
  budgetUsd: number | null;
  spentTodayUsd: number;
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

/**
 * Daily automation budget — shows today's automation spend against the cap and
 * lets the user set or clear it. When the cap is reached the scheduler skips
 * scheduled runs (recorded as skipped, with one notification per day).
 */
export function AutomationBudgetControl() {
  const [state, setState] = useState<BudgetState | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    const res = await window.electron?.automation.budget?.get();
    if (res && !("error" in res)) setState(res);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const save = async (usd: number | null) => {
    await window.electron?.automation.budget?.set(usd);
    await load();
  };

  if (!state) return null;
  const { budgetUsd, spentTodayUsd } = state;
  const reached = budgetUsd !== null && spentTodayUsd >= budgetUsd;
  const pct = budgetUsd ? Math.min(100, (spentTodayUsd / budgetUsd) * 100) : 0;

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) setDraft(budgetUsd ? String(budgetUsd) : ""); }}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border transition-colors tabular-nums",
            reached
              ? "border-[color-mix(in_srgb,var(--danger)_40%,transparent)] text-[var(--danger)]"
              : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
          )}
          aria-label="Daily automation budget"
        >
          <Wallet size={12} />
          {budgetUsd === null ? `${fmt(spentTodayUsd)} today` : `${fmt(spentTodayUsd)} / ${fmt(budgetUsd)}`}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-3">
        <div className="text-xs font-medium text-[var(--text-primary)] mb-1">Daily automation budget</div>
        <p className="text-[0.714rem] text-[var(--text-tertiary)] mb-2">
          Estimated spend by automations since midnight. When it reaches the budget, scheduled runs are skipped until tomorrow. Manual runs still work.
        </p>
        {budgetUsd !== null && (
          <div className="h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden mb-2" aria-hidden="true">
            <div className="h-full" style={{ width: `${pct}%`, background: reached ? "var(--danger)" : "var(--accent)" }} />
          </div>
        )}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); const n = Number(draft); void save(draft.trim() === "" || !(n > 0) ? null : n); }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <span className="text-xs text-[var(--text-tertiary)]">$</span>
          <input
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="No limit"
            aria-label="Budget in US dollars"
            className="flex-1 min-w-0 px-2 py-1 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button type="submit" className="px-2 py-1 text-xs rounded-md bg-[var(--accent)] text-[var(--accent-fg)]">Save</button>
          {budgetUsd !== null && (
            <button type="button" onClick={() => void save(null)} className="px-2 py-1 text-xs rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
              Clear
            </button>
          )}
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
