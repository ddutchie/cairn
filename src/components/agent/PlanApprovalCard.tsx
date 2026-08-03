"use client";

import { useState } from "react";
import { CheckCircle, MessageSquare, Play, Send } from "lucide-react";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";

interface PlanApprovalCardProps {
  content: string;
  busy: boolean;
  onApprove: (autoApprove: boolean) => void;
  onRequestChanges: (feedback: string) => void;
}

export function PlanApprovalCard({ content, busy, onApprove, onRequestChanges }: PlanApprovalCardProps) {
  const [requesting, setRequesting] = useState(false);
  const [feedback, setFeedback] = useState("");

  function submitFeedback() {
    const value = feedback.trim();
    if (!value) return;
    onRequestChanges(value);
    setFeedback("");
    setRequesting(false);
  }

  return (
    <section data-testid="plan-approval-card" className="mx-3 mb-2 rounded-lg border border-[color-mix(in_srgb,var(--warning,#f59e0b)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning,#f59e0b)_5%,var(--surface))] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <CheckCircle size={13} className="text-[var(--warning,#f59e0b)]" />
        <span className="text-[0.714rem] font-semibold text-[var(--text-primary)] flex-1">Plan ready for your direction</span>
        <span className="text-[0.607rem] uppercase tracking-wider text-[var(--text-tertiary)]">Choose autonomy</span>
      </div>
      <div className="max-h-52 overflow-y-auto px-3 py-2 text-[0.714rem] leading-relaxed text-[var(--text-secondary)]">
        <MarkdownContent content={content} />
      </div>
      {requesting && (
        <div className="px-3 pb-2">
          <textarea
            autoFocus
            data-testid="plan-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="What should change?"
            rows={2}
            className="w-full resize-none rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[0.714rem] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <button onClick={() => setRequesting(false)} className="px-2 py-1 text-[0.643rem] text-[var(--text-tertiary)]">Cancel</button>
            <button data-testid="plan-submit-feedback" disabled={!feedback.trim() || busy} onClick={submitFeedback} className="inline-flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-1 text-[0.643rem] font-semibold text-[var(--accent-fg)] disabled:opacity-50"><Send size={10} /> Send feedback</button>
          </div>
        </div>
      )}
      {!requesting && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-t border-[var(--border)]">
          <button data-testid="plan-request-changes" disabled={busy} onClick={() => setRequesting(true)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[0.643rem] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"><MessageSquare size={10} /> Request changes</button>
          <span className="flex-1" />
          <button data-testid="plan-approve-interactive" disabled={busy} onClick={() => onApprove(false)} className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[0.643rem] font-semibold text-[var(--text-secondary)] hover:border-[var(--accent)] disabled:opacity-50">Ask per step</button>
          <button data-testid="plan-approve-auto" disabled={busy} onClick={() => onApprove(true)} className="inline-flex items-center gap-1 rounded bg-[var(--success,#22c55e)] px-2 py-1 text-[0.643rem] font-semibold text-white hover:opacity-90 disabled:opacity-50"><Play size={10} /> Approve &amp; run</button>
        </div>
      )}
    </section>
  );
}
