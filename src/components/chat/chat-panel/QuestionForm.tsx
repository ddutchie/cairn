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

/** Short heading — dsh 'header', Cairn 'label', fall back to a truncated body. */
function questionHeader(q: PendingQuestion): string {
  return q.header?.trim() || q.label?.trim() || questionBody(q).slice(0, 60);
}

/** Full body — dsh 'question', Cairn 'prompt', fall back to header for
 *  degenerate payloads that carry only a title. */
function questionBody(q: PendingQuestion): string {
  return (q.question?.trim() || q.prompt?.trim() || q.header?.trim() || q.label?.trim() || "");
}

export function QuestionForm({ questions, onSubmit, onSubmitStructured, disabled = false }: QuestionFormProps) {
  const [answers, setAnswers]   = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [mod] = useState(() => modKey());

  // A question is "filled" when the user has either typed a free-text answer
  // OR (for a dsh options question) clicked one of the choices.
  const isFilled = (q: PendingQuestion) => {
    if ((answers[q.id] ?? "").trim().length > 0) return true;
    const sel = selected[q.id] ?? [];
    return q.options && q.options.length > 0 ? sel.length > 0 : false;
  };
  const allFilled = questions.every(isFilled);

  function handleSubmit() {
    if (!allFilled || submitted || disabled) return;
    setSubmitted(true);
    // Structured answers keyed by question id (free-text → custom, options →
    // selected[]) for the blocking Cordis path; the model reads these as the
    // tool result.
    if (onSubmitStructured) {
      const json = JSON.stringify({
        answers: questions.map((q) => ({
          id: q.id,
          selected: selected[q.id] ?? [],
          custom: (answers[q.id]?.trim() ?? "") || undefined,
        })),
      });
      if (onSubmitStructured(json)) return;
    }
    const text = questions
      .map((q) => {
        const head = questionHeader(q);
        const chosen = (selected[q.id] ?? []).join(", ");
        const custom = answers[q.id]?.trim() ?? "";
        const body = [chosen, custom].filter(Boolean).join(" — ");
        return `**${head}:** ${body}`;
      })
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
        {questions.map((q) => {
          const head = questionHeader(q);
          const body = questionBody(q);
          const opts = q.options && q.options.length > 0 ? q.options : null;
          const chosen = selected[q.id] ?? [];
          const multi = q.multiSelect === true;
          const toggleOption = (opt: string) => {
            setSelected((prev) => {
              const cur = prev[q.id] ?? [];
              if (multi) {
                return { ...prev, [q.id]: cur.includes(opt) ? cur.filter((c) => c !== opt) : [...cur, opt] };
              }
              return { ...prev, [q.id]: cur[0] === opt ? [] : [opt] };
            });
          };
          return (
            <div key={q.id} className="flex flex-col gap-1">
              {/* Head (short label) and body (full question) are BOTH rendered
                  as persistent text — NOT as the textarea placeholder — so
                  the user's context stays visible while typing. */}
              <label htmlFor={q.id} className="text-[0.786rem] font-semibold text-[var(--text-primary)]">{head}</label>
              {body && body !== head && (
                <p id={`${q.id}-prompt`} className="text-[0.714rem] text-[var(--text-tertiary)] leading-relaxed">{body}</p>
              )}
              {opts && (
                <div className="flex flex-wrap gap-1.5">
                  {opts.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => toggleOption(opt)}
                      disabled={disabled || submitted}
                      className={cn(
                        "px-2.5 py-1 rounded-md border text-[0.714rem] transition-colors",
                        chosen.includes(opt)
                          ? "bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]"
                          : "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)] hover:border-[var(--accent)]",
                        (disabled || submitted) && "opacity-50 cursor-not-allowed",
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                id={q.id}
                aria-describedby={body ? `${q.id}-prompt` : undefined}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  // Ctrl/Cmd+Enter submits the form
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
                }}
                disabled={disabled || submitted}
                rows={opts ? 1 : 2}
                placeholder={opts ? "Or type a free-text answer…" : ""}
                className="w-full px-2.5 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-none disabled:opacity-50 transition-colors leading-relaxed"
              />
            </div>
          );
        })}

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
