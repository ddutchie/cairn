"use client";

import React, { useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PendingQuestion } from "@/hooks/useChatStream";

interface QuestionFormProps {
  questions: PendingQuestion[];
  /** Called with a formatted answer string ready to send as a user message. */
  onSubmit: (answersText: string) => void;
  disabled?: boolean;
}

export function QuestionForm({ questions, onSubmit, disabled = false }: QuestionFormProps) {
  const [answers, setAnswers]   = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const allFilled = questions.every((q) => (answers[q.id] ?? "").trim().length > 0);

  function handleSubmit() {
    if (!allFilled || submitted || disabled) return;
    setSubmitted(true);
    const text = questions
      .map((q) => `**${q.label}:** ${answers[q.id]?.trim() ?? ""}`)
      .join("\n");
    onSubmit(text);
  }

  return (
    <div className="flex gap-2 items-start">
      {/* Bot avatar — mirrors ChatMessageBubble assistant style */}
      <div className="w-6 h-6 rounded-full bg-[var(--accent-dim)] border border-[var(--accent)]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot size={11} className="text-[var(--accent)]" />
      </div>

      <div className={cn(
        "flex-1 min-w-0 rounded-xl rounded-tl-sm border px-3 py-2.5 flex flex-col gap-2.5 transition-opacity",
        submitted ? "bg-[var(--surface)] border-[var(--border)] opacity-60" : "bg-[var(--surface-2)] border-[var(--border)]",
      )}>
        {questions.map((q) => (
          <div key={q.id} className="flex flex-col gap-1">
            <label className="text-[0.786rem] font-semibold text-[var(--text-primary)]">{q.label}</label>
            <textarea
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter submits the form
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
              }}
              placeholder={q.prompt}
              disabled={disabled || submitted}
              rows={2}
              className="w-full px-2.5 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent-dim)] resize-none disabled:opacity-50 transition-colors leading-relaxed"
            />
          </div>
        ))}

        {submitted ? (
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">Answers submitted</p>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-[0.714rem] text-[var(--text-tertiary)]">⌘↩ to submit</p>
            <Button
              variant="accent" size="sm"
              onClick={handleSubmit}
              disabled={disabled || !allFilled}
            >
              Continue →
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
