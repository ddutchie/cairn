import { AlertTriangle } from "lucide-react";
import { outputBudgetPressure } from "../../../shared/models/model-catalog";

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n));

/**
 * Shown under "Max output tokens" when the reserved output eats a large share
 * of the context window: compaction triggers on what is left, so a big output
 * cap on a small (typically local) model compacts almost every turn.
 */
export function OutputBudgetWarning({ contextWindow, outputTokens }: { contextWindow: number; outputTokens: number }) {
  const pressure = outputBudgetPressure(contextWindow, outputTokens);
  if (!pressure) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-[var(--warning)] px-3 py-2 text-[0.714rem] text-[var(--text-secondary)]"
      style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}
    >
      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warning)]" />
      <span>
        You have {fmt(contextWindow)} context with {fmt(outputTokens)} output tokens. Compaction will occur more often:
        only {fmt(pressure.messageBudget)} remain for the system prompt, tools and conversation, and it compacts at ~{fmt(pressure.compactAt)}.
        Consider reducing your output tokens.
      </span>
    </div>
  );
}
