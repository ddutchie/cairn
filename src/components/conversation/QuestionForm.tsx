"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { MessageAvatar } from "./message-ui";
import { MarkdownContent } from "./MarkdownContent";
import { cn } from "@/lib/utils";
import { modKey } from "@/components/layout/sidebar-utils";
import type { PendingQuestion, PendingQuestionOption } from "@/components/conversation/conversation-message";

interface QuestionFormProps {
  questions: PendingQuestion[];
  /** Called with a formatted answer string ready to send as a user message. */
  onSubmit: (answersText: string) => void;
  /**
   * Called with structured answers (JSON blob) for the blocking Cordis flow.
   * When it returns true it handled the submit (same-turn answer); when false
   * or absent, the form falls back to onSubmit(text) (built-in new-turn).
   *
   * dsh's `interaction.ask()` blocks the tool call and unblocks on this JSON:
   *   { answers: [{ id, selected: string[], custom?: string }] }
   * The `selected` array carries chosen option LABELS (dsh compares by
   * label — `answer.selected[0] === APPROVE_LABEL`), and `custom` is the
   * user's free-text override. Sending `custom: undefined` (not `""`) is
   * critical for plan-mode: dsh's `exit_plan_mode` requires
   * `item.custom === undefined` to treat a selection as approval — an
   * empty string is treated as "keep planning with this feedback".
   */
  onSubmitStructured?: (answersJson: string) => boolean;
  disabled?: boolean;
}

/** dsh option objects can be strings or {label, description}. Normalise both. */
function optionLabel(opt: PendingQuestionOption): string {
  return typeof opt === "string" ? opt : opt.label;
}
function optionDescription(opt: PendingQuestionOption): string | undefined {
  return typeof opt === "string" ? undefined : opt.description;
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

/** True when this question is dsh-plan-mode's `exit_plan_mode` review. */
function isPlanReview(q: PendingQuestion): boolean {
  return q.intent?.kind === "plan-review";
}

// ── Specialised plan-review UI ───────────────────────────────────────────────
//
// dsh-plan-mode's `exit_plan_mode` tool commits the completed plan for user
// review via `ctx.userQuestions.ask()`, with the FULL markdown plan carried
// in `detail`, `question: 'Approve this plan and leave plan mode?'`, and
// `intent.kind === 'plan-review'`. A generic textarea+options form would
// bury the plan under UI chrome and put the wrong affordance forward.
// PlanReviewCard renders the plan front and centre with big Approve /
// Request-changes controls, and — on Approve — sends the structured answer
// dsh requires: `{selected: ['Approve'], custom: undefined}`. Feedback in
// the textarea becomes `{selected: [], custom: '<feedback>'}` which dsh
// interprets as "keep planning".

interface PlanReviewCardProps {
  question: PendingQuestion;
  disabled?: boolean;
  onDecide: (selected: string[], custom?: string) => void;
  onDismiss: () => void;
}

function PlanReviewCard({ question, disabled, onDecide, onDismiss }: PlanReviewCardProps) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const opts = question.options ?? [];
  const approveLabel = question.intent?.approve?.trim()
    || opts.map(optionLabel).find((l) => /approve/i.test(l))
    || "Approve";
  const keepLabel = opts.map(optionLabel).find((l) => l !== approveLabel) || "Keep planning";
  const approveDesc = opts.find((o) => optionLabel(o) === approveLabel);
  const keepDesc = opts.find((o) => optionLabel(o) === keepLabel);
  const plan = question.detail?.trim() || questionBody(question);

  const doApprove = () => {
    if (busy || disabled) return;
    setBusy(true);
    // dsh's exit_plan_mode requires `custom === undefined` for approval:
    // stringify drops undefined keys, so passing `undefined` here maps to
    // an absent `custom` field on the wire (which is what dsh checks).
    onDecide([approveLabel], undefined);
  };
  const doKeepPlanning = () => {
    if (busy || disabled) return;
    const custom = feedback.trim();
    setBusy(true);
    if (!custom) {
      // Empty feedback: send the "Keep planning" selection so dsh returns
      // the standard keep-planning error and the model tries again.
      onDecide([keepLabel], undefined);
      return;
    }
    // Non-empty feedback: dsh's exit_plan_mode requires `custom === undefined`
    // for approval, so ANY custom string is treated as feedback. Send an
    // empty selected[] with the custom text — dsh's error message will
    // include the feedback in the message the model sees.
    onDecide([], custom);
  };
  const doDismiss = () => {
    if (busy || disabled) return;
    setBusy(true);
    onDismiss();
  };

  return (
    <section
      data-testid="plan-review-card"
      className="rounded-xl border border-[color-mix(in_srgb,var(--warning,#f59e0b)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning,#f59e0b)_5%,var(--surface-2))] overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <span className="text-[0.786rem] font-semibold text-[var(--text-primary)] flex-1">
          {question.header?.trim() || "Plan review"}
        </span>
        <span className="text-[0.643rem] uppercase tracking-wider text-[var(--text-tertiary)]">
          {question.question?.trim() || "Approve this plan?"}
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto px-3 py-2 text-[0.786rem] leading-relaxed text-[var(--text-primary)] bg-[var(--surface)]">
        <MarkdownContent content={plan} />
      </div>
      <div className="border-t border-[var(--border)] px-3 py-2 flex flex-col gap-2">
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              doKeepPlanning();
            }
          }}
          placeholder="What should change?"
          rows={2}
          disabled={disabled || busy}
          className="w-full px-2.5 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-none disabled:opacity-50 transition-colors leading-relaxed"
        />
        <div className="flex items-center gap-2 justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={doDismiss}
            disabled={disabled || busy}
            data-testid="plan-review-discuss"
            title="Chat about the plan instead of choosing an option"
          >
            Chat about it
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={doKeepPlanning}
            disabled={disabled || busy}
            data-testid="plan-review-keep"
            title={(keepDesc && optionDescription(keepDesc)) || "Reject the plan and keep planning"}
          >
            {feedback.trim() ? "Send feedback" : "Refuse"}
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={doApprove}
            disabled={disabled || busy}
            data-testid="plan-review-approve"
            title={(approveDesc && optionDescription(approveDesc)) || "Approve the plan and leave plan mode"}
          >
            {approveLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function QuestionForm({ questions, onSubmit, onSubmitStructured, disabled = false }: QuestionFormProps) {
  const [answers, setAnswers]   = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [mod] = useState(() => modKey());

  // If the whole payload is a plan-review, present the specialised card
  // instead of a generic form. Plan-mode always sends exactly one question
  // with intent.kind==='plan-review'; a payload mixing plan-review with
  // other questions is not a shape dsh emits, so we don't try to compose.
  const planReviewQ = questions.length === 1 && isPlanReview(questions[0]) ? questions[0] : null;

  const dispatchStructured = (payloadAnswers: Array<{ id: string; selected: string[]; custom?: string }>): void => {
    setSubmitted(true);
    const json = JSON.stringify({ answers: payloadAnswers });
    if (onSubmitStructured?.(json)) return;
    // No structured seam — fall back to a formatted text message.
    const text = payloadAnswers
      .map((a) => `${a.selected.join(", ")}${a.custom ? ` — ${a.custom}` : ""}`)
      .join("\n");
    onSubmit(text);
  };

  /**
   * Signal dismissal — the user closed the question without answering
   * ("Discuss" on plan-review, or the pane's own close affordance). Sends
   * a `{ __dismissed__: true }` sentinel that the main-side provider
   * translates to a `UserQuestionError('ASK_CANCELLED')`. For plan-review
   * that lands as "user dismissed the review to speak instead" — the model
   * stays in plan mode and waits for the user's next message. If the seam
   * doesn't accept structured payloads, the fallback text is a plain "-"
   * (a no-content user message).
   */
  const dispatchDismiss = (): void => {
    setSubmitted(true);
    const json = JSON.stringify({ __dismissed__: true });
    if (onSubmitStructured?.(json)) return;
    onSubmit("-");
  };

  if (planReviewQ) {
    return (
      <div className="flex gap-2 items-start">
        <MessageAvatar role="bot" size="lg" />
        <div className="flex-1 min-w-0">
          {submitted ? (
            <p className="text-[0.714rem] text-[var(--text-tertiary)] px-1">Plan decision submitted</p>
          ) : (
            <PlanReviewCard
              question={planReviewQ}
              disabled={disabled}
              onDecide={(sel, custom) => dispatchStructured([{ id: planReviewQ.id, selected: sel, custom }])}
              onDismiss={dispatchDismiss}
            />
          )}
        </div>
      </div>
    );
  }

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
    // dsh's blocking path expects a structured JSON with each answer's
    // selected + custom. Sending `custom: undefined` (NOT `""`) matters for
    // plan-review (empty string is 'keep planning with empty feedback', not
    // approval). See PlanReviewCard for the plan-mode-specific handling.
    if (onSubmitStructured) {
      const payloadAnswers = questions.map((q) => ({
        id: q.id,
        selected: selected[q.id] ?? [],
        custom: (answers[q.id]?.trim() ?? "") || undefined,
      }));
      dispatchStructured(payloadAnswers);
      return;
    }
    setSubmitted(true);
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
        {questions.map((q, questionIndex) => {
          const head = questionHeader(q);
          const body = questionBody(q);
          const opts = q.options && q.options.length > 0 ? q.options : null;
          const chosen = selected[q.id] ?? [];
          const multi = q.multiSelect === true;
          const toggleOption = (label: string) => {
            setSelected((prev) => {
              const cur = prev[q.id] ?? [];
              if (multi) {
                return { ...prev, [q.id]: cur.includes(label) ? cur.filter((c) => c !== label) : [...cur, label] };
              }
              return { ...prev, [q.id]: cur[0] === label ? [] : [label] };
            });
          };
          return (
            <div key={`${q.id}-${questionIndex}`} className="flex flex-col gap-1">
              {/* Head (short label) and body (full question) are BOTH rendered
                  as persistent text — NOT as the textarea placeholder — so
                  the user's context stays visible while typing. */}
              <label htmlFor={q.id} className="text-[0.786rem] font-semibold text-[var(--text-primary)]">{head}</label>
              {body && body !== head && (
                <p id={`${q.id}-prompt`} className="text-[0.714rem] text-[var(--text-tertiary)] leading-relaxed">{body}</p>
              )}
              {q.detail?.trim() && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[0.714rem] leading-relaxed text-[var(--text-primary)]">
                  <MarkdownContent content={q.detail} />
                </div>
              )}
              {opts && (
                <div className="flex flex-wrap gap-1.5">
                  {opts.map((opt, optionIndex) => {
                    const label = optionLabel(opt);
                    const desc = optionDescription(opt);
                    return (
                      <button
                        key={`${q.id}-${questionIndex}-${label}-${optionIndex}`}
                        type="button"
                        title={desc}
                        onClick={() => toggleOption(label)}
                        disabled={disabled || submitted}
                        className={cn(
                          "px-2.5 py-1 rounded-md border text-[0.714rem] transition-colors",
                          chosen.includes(label)
                            ? "bg-[var(--accent)] text-[var(--accent-fg)] border-[var(--accent)]"
                            : "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)] hover:border-[var(--accent)]",
                          (disabled || submitted) && "opacity-50 cursor-not-allowed",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
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
