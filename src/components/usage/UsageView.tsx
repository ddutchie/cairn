"use client";

import React, { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUsage, USAGE_RANGES } from "@/hooks/useUsage";
import { UsageChart, type UsageMetric } from "./UsageChart";
import { fmtCompact, fmtFull, fmtDateTime } from "./usage-format";
import { formatUsd } from "../../../shared/chat/provider-credits";
import { USAGE_SOURCE_LABELS, type UsageSource, type UsageTotals } from "@/types/usage";

const MODEL_PALETTE = [
  "var(--accent)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--node-project)",
  "var(--danger)",
  "var(--muted-fg)",
];

/**
 * Model → colour. Brand-based so the models people actually run (deepseek,
 * openai, anthropic, google…) are always visually distinct — a plain string
 * hash collided for common ids (e.g. deepseek-v4-flash and gpt-5.6-luna both
 * landed on amber). Unknown brands fall back to an FNV-1a hash.
 */
const MODEL_BRAND_COLORS: Array<[RegExp, string]> = [
  [/deepseek/i, "var(--warning)"],
  [/^gpt|^o[1-9]|openai/i, "var(--info)"],
  [/claude|anthropic/i, "var(--node-project)"],
  [/gemini|google/i, "var(--accent)"],
  [/qwen|alibaba/i, "var(--danger)"],
  [/llama|meta/i, "var(--success)"],
  [/mistral|ministral/i, "var(--accent-hover)"],
  [/grok|xai/i, "var(--muted-fg)"],
];

function modelColor(model: string): string {
  if (model) {
    const base = model.toLowerCase().split(/[/:]/).pop() ?? model;
    for (const [re, color] of MODEL_BRAND_COLORS) {
      if (re.test(base)) return color;
    }
  }
  // FNV-1a fallback for unknown brands — distributes much better than the old
  // (h*31) hash, so arbitrary model ids don't collide onto one colour.
  let h = 0x811c9dc5;
  for (let i = 0; i < model.length; i++) {
    h ^= model.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return MODEL_PALETTE[(h >>> 0) % MODEL_PALETTE.length];
}

const SOURCE_TAG_STYLE: Record<string, string> = {
  chat: "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent-hover)]",
  "pi-agent": "bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info)]",
  "chat-subagent": "bg-[color-mix(in_srgb,var(--node-project)_14%,transparent)] text-[var(--node-project)]",
  "pi-subagent": "bg-[color-mix(in_srgb,var(--node-project)_14%,transparent)] text-[var(--node-project)]",
  automation: "bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]",
};

/**
 * Bordered segmented control matching InsightsView's toggle style: accent-dim
 * active state with 1px dividers between options (NOT the filled accent pill).
 */
function Segmented<T extends string | number>({ options, value, onChange }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
      {options.map((opt, idx) => (
        <React.Fragment key={String(opt.value)}>
          {idx > 0 && <div className="w-px h-5 bg-[var(--border)]" />}
          <button
            onClick={() => onChange(opt.value)}
            className={cn(
              "px-2.5 py-1.5 text-xs transition-colors",
              opt.value === value
                ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            )}
          >
            {opt.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

function StatCard({ label, value, valueClass, delta }: { label: string; value: string; valueClass?: string; delta?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 flex flex-col gap-0.5">
      <div className="text-[0.643rem] uppercase tracking-[0.07em] text-[var(--text-tertiary)]">{label}</div>
      <div className={`font-mono text-xl font-semibold tabular-nums tracking-tight ${valueClass ?? "text-[var(--text-primary)]"}`}>{value}</div>
      {delta ? (
        <div className={cn("text-[0.643rem]", delta.startsWith("↑") ? "text-[var(--success)]" : delta.startsWith("↓") ? "text-[var(--danger)]" : "text-[var(--text-tertiary)]")}>{delta}</div>
      ) : (
        <div className="text-[0.643rem] text-[var(--text-tertiary)]">—</div>
      )}
    </div>
  );
}

function deltaPct(cur: UsageTotals, prev: UsageTotals | null, field: "promptTokens" | "costUsd", rangeLabel: string): string {
  if (!prev || prev[field] <= 0) return "";
  const d = ((cur[field] - prev[field]) / prev[field]) * 100;
  const arrow = d >= 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(d).toFixed(1)}% vs prior ${rangeLabel}`;
}

export function UsageView() {
  const [rangeIdx, setRangeIdx] = useState(1); // 30D default
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [source, setSource] = useState<UsageSource | "">("");

  const range = USAGE_RANGES[rangeIdx];
  const { overview, recent, loading, refresh } = useUsage(range.days, source);

  const totals = overview?.totals;
  const rangeLabel = range.days == null ? "period" : `${range.days}d`;

  const byModel = useMemo(() => {
    if (!overview) return [];
    const max = Math.max(1, ...overview.byModel.map((m) => m.promptTokens + m.completionTokens));
    return overview.byModel.map((m) => ({ ...m, pct: (m.promptTokens + m.completionTokens) / max }));
  }, [overview]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-[var(--background)]">
      {/* Toolbar — mirrors InsightsView / KnowledgeGraphView chrome */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex-wrap">
        <div className="text-sm font-semibold text-[var(--text-primary)] mr-1">Usage</div>
        <div className="text-[0.714rem] text-[var(--text-tertiary)] mr-2">AI spend across chat, agents &amp; automations</div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<UsageMetric>
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "Cost" },
              { value: "requests", label: "Requests" },
            ]}
            value={metric}
            onChange={setMetric}
          />
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as UsageSource | "")}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text-secondary)] outline-none"
          >
            <option value="">All sources</option>
            {(Object.keys(USAGE_SOURCE_LABELS) as UsageSource[]).map((k) => (
              <option key={k} value={k}>
                {USAGE_SOURCE_LABELS[k]}
              </option>
            ))}
          </select>
          <Segmented<number>
            options={USAGE_RANGES.map((r, i) => ({ value: i, label: r.label }))}
            value={rangeIdx}
            onChange={setRangeIdx}
          />
          <button
            onClick={refresh}
            title="Reload data"
            className="flex items-center gap-1 px-1.5 py-1 rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Content — full-bleed scroll area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 flex flex-col gap-4">
          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Input tokens" value={totals ? fmtCompact(totals.promptTokens) : "—"} valueClass="text-[var(--accent)]" delta={totals && overview?.previous ? deltaPct(totals, overview.previous, "promptTokens", rangeLabel) : undefined} />
            <StatCard label="Output tokens" value={totals ? fmtCompact(totals.completionTokens) : "—"} />
            <StatCard label="Total cost" value={totals ? formatUsd(totals.costUsd) : "—"} delta={totals && overview?.previous ? deltaPct(totals, overview.previous, "costUsd", rangeLabel) : undefined} />
            <StatCard label="Requests" value={totals ? fmtFull(totals.requests) : "—"} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)] gap-4">
            {/* Chart */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <div className="text-xs font-semibold text-[var(--text-primary)]">Token usage</div>
                <div className="text-[0.643rem] text-[var(--text-tertiary)]">
                  {metric === "tokens" ? "daily totals" : metric === "cost" ? "provider-reported + models.dev estimates" : "LLM calls"}
                </div>
              </div>
              <div className="flex items-center gap-4 px-4 pb-1 text-[0.643rem] uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[var(--accent)]" /> Input
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[var(--info)]" /> Output
                </span>
              </div>
              <div className="px-2 pb-2">
                <UsageChart series={overview?.series ?? []} metric={metric} />
              </div>
            </div>

            {/* By model */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <div className="text-xs font-semibold text-[var(--text-primary)]">By model</div>
                <div className="text-[0.643rem] text-[var(--text-tertiary)]">{rangeLabel}</div>
              </div>
              <div className="p-4 flex flex-col gap-3">
                {byModel.length === 0 ? (
                  <div className="text-xs text-[var(--text-tertiary)]">No usage yet.</div>
                ) : (
                  byModel.slice(0, 6).map((m) => {
                    const color = modelColor(m.model);
                    return (
                      <div key={m.model}>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-primary)] truncate">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                            <span className="font-mono truncate">{m.model}</span>
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-[0.643rem] text-[var(--text-tertiary)] shrink-0">
                            <span className="font-mono text-[var(--text-secondary)]">{fmtCompact(m.promptTokens + m.completionTokens)}</span>
                            <span>·</span>
                            <span className="font-mono">{formatUsd(m.costUsd)}</span>
                          </span>
                        </div>
                        <div className="h-1.5 rounded bg-[var(--surface-2)] overflow-hidden">
                          <div className="h-full rounded" style={{ width: `${Math.max(2, m.pct * 100).toFixed(1)}%`, background: color, opacity: 0.85 }} />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* History table */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <div className="text-xs font-semibold text-[var(--text-primary)]">Usage history</div>
              <div className="text-[0.643rem] text-[var(--text-tertiary)]">{recent.length === 0 ? "" : `latest ${recent.length} calls`}</div>
            </div>
            {recent.length > 0 && (
              <div className="px-4 pb-1 text-[0.643rem] text-[var(--text-tertiary)]">~ = estimated from models.dev pricing</div>
            )}
            {recent.length === 0 ? (
              <div className="px-4 py-8 text-xs text-[var(--text-tertiary)]">
                No LLM calls recorded yet — send a chat message or run an agent and it will appear here.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[0.643rem] uppercase tracking-[0.07em] text-[var(--text-tertiary)]">
                      <th className="text-left font-medium px-4 py-2 whitespace-nowrap">Time</th>
                      <th className="text-left font-medium px-4 py-2 whitespace-nowrap">Model</th>
                      <th className="text-right font-medium px-4 py-2 whitespace-nowrap">Input</th>
                      <th className="text-right font-medium px-4 py-2 whitespace-nowrap">Output</th>
                      <th className="text-right font-medium px-4 py-2 whitespace-nowrap">Reasoning</th>
                      <th className="text-left font-medium px-4 py-2 whitespace-nowrap">Provider</th>
                      <th className="text-left font-medium px-4 py-2 whitespace-nowrap">Source</th>
                      <th className="text-right font-medium px-4 py-2 whitespace-nowrap">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => (
                      <tr key={r.id} className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--surface-2)]">
                        <td className="px-4 py-2 whitespace-nowrap text-[0.714rem] text-[var(--text-secondary)]">{fmtDateTime(r.createdAt)}</td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: modelColor(r.model) }} />
                            <span className="font-mono font-medium">{r.model}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-right font-mono tabular-nums text-[var(--accent)]">{fmtFull(r.promptTokens)}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-right font-mono tabular-nums text-[var(--info)]">{fmtFull(r.completionTokens)}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-right font-mono tabular-nums text-[var(--text-tertiary)]">{r.reasoningTokens > 0 ? fmtFull(r.reasoningTokens) : "—"}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-[0.714rem] text-[var(--text-secondary)]">{r.provider ?? "—"}</td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[0.643rem] font-medium ${SOURCE_TAG_STYLE[r.source] ?? "bg-[var(--surface-2)] text-[var(--text-secondary)]"}`}>
                            {USAGE_SOURCE_LABELS[r.source] ?? r.source}
                          </span>
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-right font-mono tabular-nums font-semibold text-[var(--text-secondary)]">{r.costUsd != null ? `${r.costEstimated ? "~" : ""}${formatUsd(r.costUsd)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
