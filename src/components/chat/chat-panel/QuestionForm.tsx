"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { MessageAvatar } from "./message-ui";
import { cn } from "@/lib/utils";
import { modKey } from "@/components/layout/sidebar-utils";
import type { PendingQuestion } from "@/hooks/useChatStream";

interface QuestionFormProps {
  questions: PendingQuestion[];
  /** Called with a formatted answer string ready to send as a user message. */
  onSubmit: (answersText: string) => void;
  /**
   * Called with structured answers (JSON blob) for the blocking Cordis flow.
   * When it returns true it handled the submit (same-turn answer); when false
   * or absent, the form falls back to onSubmit(text) (built-in new-turn).
   */
  onSubmitStructured?: (answersJson: string) => boolean;
  disabled?: boolean;
}

export function QuestionForm({ questions, onSubmit, onSubmitStructured, disabled = false }: QuestionFormProps) {
  const [answers, setAnswers]   = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [mod] = useState(() => modKey());

  const allFilled = questions.every((q) => (answers[q.id] ?? "").trim().length > 0);

  function handleSubmit() {
    if (!allFilled || submitted || disabled) return;
    setSubmitted(true);
    // Structured answers keyed by question id (free-text → custom) for the
    // blocking Cordis path; the model reads these as the tool result.
    if (onSubmitStructured) {
      const json = JSON.stringify({
        answers: questions.map((q) => ({ id: q.id, selected: [], custom: answers[q.id]?.trim() ?? "" })),
      });
      if (onSubmitStructured(json)) return;
    }
    const text = questions
      .map((q) => `**${q.label}:** ${answers[q.id]?.trim() ?? ""}`)
      .join("\n");
    onSubmit(text);
  }

  return (
    <div className="flex gap-2 items-start">
      <MessageAvatar role="bot" size="lg" />

      <div className={cn(
        "flex-1 min-w-0 rounded-xl rounded-tl-sm border px-3 py-2.5 flex flex-col gap-2.5 transition-opacity",
        submitted ? "bg-[var(--surface)] border-[var(--border)] opacity-60" : "bg-[var(--surface-2)] border-[var(--border)]",
      )}>
        {questions.map((q) => (
          <div key={q.id} className="flex flex-col gap-1">
            <label htmlFor={q.id} className="text-[0.786rem] font-semibold text-[var(--text-primary)]">{q.label}</label>
            {/* The question is rendered as persistent text — NOT as the textarea
                placeholder — so it stays visible while the user types. */}
            <p id={`${q.id}-prompt`} className="text-[0.714rem] text-[var(--text-tertiary)] leading-relaxed">{q.prompt}</p>
            <textarea
              id={q.id}
              aria-describedby={`${q.id}-prompt`}
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter submits the form
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
              }}
              disabled={disabled || submitted}
              rows={2}
              className="w-full px-2.5 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-none disabled:opacity-50 transition-colors leading-relaxed"
            />
          </div>
        ))}

        {submitted ? (
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">Answers submitted</p>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-[0.714rem] text-[var(--text-tertiary)]">{mod}↩ to submit</p>
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
