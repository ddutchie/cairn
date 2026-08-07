"use client";

import React, { useEffect, useSyncExternalStore, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { formatBalance, formatUsd } from "../../../shared/chat/provider-credits";
import { Tooltip } from "@/components/ui/tooltip";
import type { TokenBreakdown } from "@/types";
import { cacheHitColor } from "@/lib/cache-metrics";

/** Provider remaining-balance (account-level), the desktop CreditInfo shape. */
interface ProviderBalance {
  remaining: number | null;
  usage: number | null;
  limit: number | null;
  isFreeTier: boolean | null;
  currency: "USD" | "CNY";
}

/** Re-probe the balance at most once per minute regardless of how many ring instances mount. */
const BALANCE_TTL_MS = 60_000;

interface BalanceEntry {
  key: string;
  data: ProviderBalance | null;
  fetchedAt: number;
}

// Shared module-level balance cache, read through useSyncExternalStore so every
// ring instance (chat header, agent pane) sees the same data without duplicate
// probes. `balanceCache` is always replaced wholesale (never mutated) so the
// getSnapshot reference stays stable between store changes.
let balanceCache: BalanceEntry | null = null;
const balanceListeners = new Set<() => void>();

function balanceSnapshot(): BalanceEntry | null {
  return balanceCache;
}

function balanceSubscribe(onStoreChange: () => void): () => void {
  balanceListeners.add(onStoreChange);
  return () => {
    balanceListeners.delete(onStoreChange);
  };
}

function updateBalance(entry: BalanceEntry): void {
  balanceCache = entry;
  for (const l of balanceListeners) l();
}

// In-flight probe shared across concurrently-mounted ring instances: when a
// cold/expired cache is probed by one ring, the others reuse its promise
// instead of firing duplicate IPC requests. Cleared once the probe settles.
let inflightBalance: { key: string; promise: Promise<ProviderBalance | null> } | null = null;

async function fetchBalance(baseUrl: string, apiKey: string): Promise<ProviderBalance | null> {
  if (typeof window === "undefined" || !window.electron?.ai?.fetchKeyInfo) return null;
  try {
    const info = await window.electron.ai.fetchKeyInfo({ baseUrl, apiKey });
    if (!info) return null;
    return {
      remaining: info.remaining,
      usage: info.usage,
      limit: info.limit,
      isFreeTier: info.isFreeTier,
      currency: info.currency,
    };
  } catch {
    return null;
  }
}

/**
 * Lazily fetch the active provider's remaining balance via the same IPC the
 * settings panel uses. TTL-cached (shared) so the chat header, agent pane and
 * message rings use one probe per minute. Returns null while loading, when the
 * provider exposes no credits, or offline — the ring hides the row then.
 */
function useProviderBalance(enabled: boolean): ProviderBalance | null {
  const { baseUrl, apiKey } = useCairnStore(
    useShallow((s) => ({ baseUrl: s.aiConfig?.baseUrl ?? "", apiKey: s.aiConfig?.apiKey ?? "" })),
  );
  const entry = useSyncExternalStore(balanceSubscribe, balanceSnapshot, balanceSnapshot);
  const key = `${baseUrl}::${apiKey}`;

  useEffect(() => {
    if (!enabled) return;
    const cached = balanceCache;
    if (cached && cached.key === key && Date.now() - cached.fetchedAt < BALANCE_TTL_MS) return;
    // No key (local/offline) → nothing to query; credit endpoints are all authed.
    if (!apiKey) {
      updateBalance({ key, data: null, fetchedAt: Date.now() });
      return;
    }
    // Another ring is already probing this provider — reuse its request.
    if (inflightBalance && inflightBalance.key === key) return;
    const promise = fetchBalance(baseUrl, apiKey);
    inflightBalance = { key, promise };
    void promise.then((data) => {
      updateBalance({ key, data, fetchedAt: Date.now() });
      if (inflightBalance && inflightBalance.key === key) inflightBalance = null;
    });
  }, [enabled, key, baseUrl, apiKey]);

  return entry && entry.key === key ? entry.data : null;
}

interface ContextRingProps {
  promptTokens: number;
  contextLimit: number;
  breakdown?: TokenBreakdown;
  /** Total completion tokens for this turn (answer + reasoning, if any). */
  completionTokens?: number;
  /** Subset of completionTokens spent on reasoning/thinking. 0/undefined if the model didn't split. */
  reasoningTokens?: number;
  /** Prompt tokens served from the provider's cache this turn (0 when the provider doesn't cache/report). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache this turn (0 when not split out). */
  cacheCreationTokens?: number;
  /** Provider-reported USD cost of the turn (e.g. Neuralwatt usage.cost), when present. */
  costUsd?: number;
  /** Show the account-level provider balance row (default true; off for subagent rings). */
  showBalance?: boolean;
  /** Ring diameter in px. Default 16. */
  size?: number;
  /** Stroke width in px. Default 2. */
  stroke?: number;
}

export function ContextRing({
  promptTokens,
  contextLimit,
  breakdown,
  completionTokens,
  reasoningTokens,
  cacheReadTokens,
  cacheCreationTokens,
  costUsd,
  showBalance = true,
  size = 16,
  stroke = 2,
}: ContextRingProps) {
  const [isOpen, setIsOpen] = useState(false);
  const balance = useProviderBalance(showBalance);

  const cacheRead = cacheReadTokens ?? 0;
  const cacheCreation = cacheCreationTokens ?? 0;
  const hasCache = cacheRead > 0 || cacheCreation > 0;

  const pct  = Math.min(promptTokens / contextLimit, 1);
  const r    = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ;

  const colour =
    pct > 0.85 ? "var(--danger)" :
    pct > 0.65 ? "var(--warning, #f59e0b)" :
    "var(--accent)";

  const pctLabel = `${Math.round(pct * 100)}%`;

  const system = breakdown?.systemPrompt ?? Math.min(promptTokens, 1500);
  const tools = breakdown?.tools ?? 0;
  const rules = breakdown?.rules ?? 0;
  const skills = breakdown?.skills ?? 0;
  const mcp = breakdown?.mcp ?? 0;
  const subagent = breakdown?.subagentDefinitions ?? 0;
  const toolOutputs = breakdown?.toolOutputs ?? 0;
  const conversation = breakdown?.conversation ?? Math.max(0, promptTokens - system - toolOutputs);

  const thinkingTokens = reasoningTokens ?? 0;
  const answerTokens = Math.max(0, (completionTokens ?? 0) - thinkingTokens);

  const categories = [
    { label: "System prompt", count: system, color: "var(--muted-fg)" },
    { label: "Tool definitions", count: tools, color: "var(--accent)" },
    { label: "Rules", count: rules, color: "var(--text-tertiary)" },
    { label: "Skills", count: skills, color: "var(--warning)" },
    { label: "MCP", count: mcp, color: "var(--border)" },
    { label: "Subagent definitions", count: subagent, color: "var(--info)" },
    { label: "Conversation", count: conversation, color: "var(--success)" },
    { label: "Tool outputs", count: toolOutputs, color: "var(--danger)" },
  ];

  function formatTokenCount(num: number): string {
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    }
    return num.toString();
  }

  const ringSvg = (
    <div className="cursor-pointer select-none flex-shrink-0 hover:opacity-80 transition-opacity flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke={colour}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.4s ease, stroke 0.4s ease" }}
        />
      </svg>
    </div>
  );

  const trigger = (
    <Popover.Trigger asChild>
      {ringSvg}
    </Popover.Trigger>
  );

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      {isOpen ? (
        trigger
      ) : (
        <Tooltip
          content={
            hasCache
              ? `Context: ${promptTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${pctLabel}) · ${formatTokenCount(cacheRead)} cached`
              : `Context: ${promptTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${pctLabel})`
          }
          side="bottom"
        >
          {trigger}
        </Tooltip>
      )}
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          className="z-50 w-72 rounded-xl bg-[var(--surface-3)] border border-[var(--border)] p-4 shadow-2xl text-xs text-[var(--text-secondary)] select-none focus:outline-none animate-fade-in"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-[var(--text-primary)] text-[0.85rem]">Context Usage</span>
            <Popover.Close asChild>
              <button className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors p-1 rounded hover:bg-[var(--surface-2)] focus:outline-none cursor-pointer">
                <X size={12} />
              </button>
            </Popover.Close>
          </div>

          {/* Info row */}
          <div className="flex items-center justify-between text-[0.714rem]">
            <span className="font-medium text-[var(--text-primary)]">{pctLabel} Full</span>
            <span className="text-[var(--text-tertiary)]">
              ~{formatTokenCount(promptTokens)} / {formatTokenCount(contextLimit)} Tokens
            </span>
          </div>

          {/* Segmented bar */}
          <div className="w-full h-1.5 bg-[var(--border)] rounded-full overflow-hidden flex my-3">
            {categories.map((c) => {
              const widthPct = (c.count / contextLimit) * 100;
              if (widthPct <= 0) return null;
              return (
                <div
                  key={c.label}
                  style={{ width: `${widthPct}%`, backgroundColor: c.color }}
                  className="h-full transition-all duration-300"
                  title={`${c.label}: ${c.count.toLocaleString()} tokens`}
                />
              );
            })}
          </div>

          {/* Legend */}
          <div className="space-y-1.5 mt-2">
            {categories.map((c) => {
              if (c.count === 0 && (c.label === "Rules" || c.label === "MCP" || c.label === "Subagent definitions" || c.label === "Skills")) return null;
              return (
                <div key={c.label} className="flex items-center justify-between text-[0.714rem]">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-sm opacity-90" style={{ backgroundColor: c.color }} />
                    <span className="text-[var(--text-secondary)]">{c.label}</span>
                  </div>
                  <span className="font-mono text-[var(--text-primary)] font-medium">
                    {formatTokenCount(c.count)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Output breakdown — only shown after the first turn completes */}
          {typeof completionTokens === "number" && completionTokens > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1.5">
              <div className="text-[0.714rem] font-semibold text-[var(--text-primary)] mb-1">Output</div>
              <div className="flex items-center justify-between text-[0.714rem]">
                <span className="text-[var(--text-secondary)]">Answer</span>
                <span className="font-mono text-[var(--text-primary)] font-medium">{formatTokenCount(answerTokens)}</span>
              </div>
              {thinkingTokens > 0 && (
                <div className="flex items-center justify-between text-[0.714rem]">
                  <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <div className="w-2.5 h-2.5 rounded-sm opacity-90" style={{ backgroundColor: "var(--accent)" }} />
                    Thinking
                  </span>
                  <span className="font-mono text-[var(--text-primary)] font-medium">{formatTokenCount(thinkingTokens)}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-[0.714rem]">
                <span className="text-[var(--text-tertiary)]">Total</span>
                <span className="font-mono text-[var(--text-tertiary)]">{formatTokenCount(completionTokens)}</span>
              </div>
            </div>
          )}

          {/* Prompt cache — tokens served from / written to the provider's cache
              (Anthropic cache_read_input_tokens / OpenAI cached_tokens). Shown
              whenever the provider reported any cached tokens this turn. */}
          {hasCache && (
            <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1.5">
              <div className="flex items-center justify-between text-[0.714rem]">
                <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                  <div className="w-2.5 h-2.5 rounded-sm opacity-90" style={{ backgroundColor: "var(--warning)" }} />
                  Prompt cache
                </span>
                <span className="font-mono text-[var(--text-primary)] font-medium">
                  {formatTokenCount(cacheRead)} read
                  {cacheCreation > 0 && <span className="text-[var(--text-tertiary)]"> · {formatTokenCount(cacheCreation)} written</span>}
                </span>
              </div>
              {cacheRead > 0 && promptTokens > 0 && (
                <div className="flex items-center justify-between text-[0.714rem]">
                  <span className="text-[var(--text-tertiary)]">% of input cached</span>
                  <span className="font-mono font-medium" style={{ color: cacheHitColor(cacheRead / promptTokens) }}>
                    {Math.round((cacheRead / promptTokens) * 100)}%
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Cost — shown whenever the provider reported a USD cost for the turn
              (including $0 from a quota diff, which means "cost was checked but
              is below the provider's reported precision"). */}
          {typeof costUsd === "number" && costUsd >= 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center justify-between text-[0.714rem]">
              <span className="text-[var(--text-secondary)]">Cost</span>
              <span className="font-mono text-[var(--text-primary)] font-semibold">
                {costUsd === 0 ? "<$0.01" : formatUsd(costUsd)}
              </span>
            </div>
          )}

          {/* Balance — account-level provider remaining credits. Hidden when the
              provider exposes none, when offline, or on subagent rings. */}
          {showBalance && balance && (balance.remaining != null || balance.usage != null || balance.isFreeTier === true) && (
            <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center justify-between text-[0.714rem]">
              <span className="text-[var(--text-secondary)]">Balance</span>
              <span className="font-mono text-[var(--text-primary)] font-semibold">
                {formatBalance(balance)}
              </span>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
