"use client";

/**
 * UserStyleWizardModal — the guided "Writing Style" setup.
 *
 * 5 steps:
 *   1. Persona basics   — who you are, your role, who you write to.
 *   2. Raw material     — paste real messages across contexts, and/or pull
 *                         recent notes + tasks from the workspace to analyse.
 *   3. Gap questions    — dimensions samples can't reveal (sign-offs, emoji,
 *                         formatting, anti-patterns, feedback style).
 *   4. Full guide       — structured LLM generation → editable preview.
 *   5. Cheat sheet      — condensed from the full guide → editable preview → save.
 *
 * Saving writes persona + full guide + cheat sheet to the user_style row with
 * source "guided" (or "analyzed" if samples were pulled from notes/tasks).
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Sparkles, Loader2, Plus, Trash2, X, FileText, PenLine, Check, Wand2 } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";
import { cn } from "@/lib/utils";
import type { UserStylePersona, UserStyleRow } from "@/types";

interface Sample {
  context: string;
  text: string;
}

const GAP_QUESTIONS = [
  { id: "signoffs", question: "How do you close messages? (e.g. 'Best, Gerard', 'Keep me posted', nothing at all)" },
  { id: "emoji", question: "Do you use emoji? Which ones, and when? (e.g. only for celebration, never at all)" },
  { id: "formatting", question: "Formatting habits — headings, lists, code blocks, tables, line breaks?" },
  { id: "antipatterns", question: "What should the AI NEVER do when writing as you? (e.g. em-dashes, corporate jargon, hedging)" },
  { id: "feedback", question: "How do you give feedback or disagree? (e.g. praise first, straight to the point)" },
];

const CONTEXTS = ["Technical reply", "Team message / DM", "Formal / outreach", "Note or doc"];

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]";
const textareaCls = cn(inputCls, "resize-y min-h-20");

const STEPS = ["Persona", "Raw material", "Questions", "Full guide", "Cheat sheet"];

export function UserStyleWizardModal({
  onClose,
  existing,
}: {
  onClose: () => void;
  existing?: UserStyleRow | null;
}) {
  const { notes, cards, saveUserStyle, aiConfig, activeWorkspaceId, activeProjectId, projects } = useCairnStore(
    useShallow((s) => ({
      notes: s.notes,
      cards: s.cards,
      saveUserStyle: s.saveUserStyle,
      aiConfig: s.aiConfig,
      activeWorkspaceId: s.activeWorkspaceId,
      activeProjectId: s.activeProjectId,
      projects: s.projects,
    })),
  );

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live streaming generation state.
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamTools, setStreamTools] = useState<Array<{ tool: string; label: string; done: boolean }>>([]);
  const unsubsRef = useRef<Array<() => void>>([]);

  // Abort + clean up listeners when the wizard closes mid-generation.
  useEffect(() => {
    return () => {
      window.electron?.abortUserStyleStream?.();
      unsubsRef.current.forEach((u) => u());
      unsubsRef.current = [];
    };
  }, []);

  // Step 1 — persona
  const [persona, setPersona] = useState<UserStylePersona>(
    existing?.persona ?? { name: "", role: "", context: "", audiences: "" },
  );

  // Step 2 — raw material
  const [samples, setSamples] = useState<Sample[]>([]);
  const [context, setContext] = useState(CONTEXTS[0]);
  const [sampleText, setSampleText] = useState("");

  // Step 3 — gap answers
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // Step 4/5 — generated + editable previews
  const [fullGuide, setFullGuide] = useState(existing?.fullGuide ?? "");
  const [cheatsheet, setCheatsheet] = useState(existing?.cheatsheet ?? "");
  // Toggle the editable textarea ↔ rendered markdown preview on steps 4/5.
  const [previewMode, setPreviewMode] = useState(false);

  const addSample = useCallback(() => {
    if (!sampleText.trim()) return;
    setSamples((prev) => [...prev, { context, text: sampleText.trim() }]);
    setSampleText("");
  }, [context, sampleText]);

  const addNotesAsSamples = useCallback(() => {
    const recentNotes = [...notes]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5)
      .map((n) => `### ${n.title}\n${(n.content ?? "").slice(0, 700)}`)
      .join("\n\n");
    const recentCards = [...cards]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5)
      .map((c) => `### ${c.title}\n${(c.description ?? "").slice(0, 400)}`)
      .join("\n\n");
    const parts: Sample[] = [];
    if (recentNotes.trim()) parts.push({ context: "From your notes (recent)", text: recentNotes });
    if (recentCards.trim()) parts.push({ context: "From your tasks (recent)", text: recentCards });
    if (parts.length) {
      setSamples((prev) => [...prev, ...parts]);
      setError(null);
    } else {
      setError("No notes or tasks yet — paste sample messages instead, or write a note first.");
    }
  }, [notes, cards]);

  const answersList = useMemo(
    () => GAP_QUESTIONS.map((q) => ({ question: q.question, answer: answers[q.id] ?? "" })).filter((a) => a.answer.trim()),
    [answers],
  );

  const generationInput = useMemo(
    () => ({ persona, samples, answers: answersList, fullGuide }),
    [persona, samples, answersList, fullGuide],
  );

  // Stream the generation so the guide (and any note-reading tool calls) appear
  // live in the preview. Falls back to the one-shot IPC when streaming isn't
  // available in this build.
  const generate = (target: "full" | "cheatsheet" | "optimize") => {
    const electron = window.electron;
    if (electron?.generateUserStyleStream) {
      const unsubs: Array<() => void> = [];
      unsubsRef.current = unsubs;
      setBusy(true);
      setError(null);
      setStreaming(true);
      setStreamingText("");
      setStreamTools([]);

      unsubs.push(
        electron.onUserStyleToken!(({ delta }) => setStreamingText((t) => t + delta)),
        electron.onUserStyleToolCall!((e) =>
          setStreamTools((prev) => [...prev, { tool: e.tool, label: e.label, done: false }]),
        ),
        electron.onUserStyleToolCallDone!((e) =>
          setStreamTools((prev) => prev.map((t) => (t.tool === e.tool ? { ...t, done: true } : t))),
        ),
        electron.onUserStyleDone!(({ content, usable, error }) => {
          unsubs.forEach((u) => u());
          unsubsRef.current = [];
          setStreaming(false);
          setStreamingText("");
          setStreamTools([]);
          if (error || !usable) {
            setBusy(false);
            setError(error || "Generation produced unusable output — try again.");
            return;
          }
          if (target === "full" || target === "optimize") {
            setFullGuide(content);
            setStep(3);
          } else {
            setCheatsheet(content);
            setStep(4);
          }
          setBusy(false);
        }),
      );

      const activeProject = projects.find((p) => p.id === activeProjectId);
      electron.generateUserStyleStream({
        config: { baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
        workspaceId: activeWorkspaceId ?? undefined,
        projectId: activeProjectId ?? undefined,
        projectName: activeProject?.name,
        step: target,
        analyseNotes: samples.some((s) => s.context.startsWith("From your")),
        input: generationInput,
      });
      return;
    }

    if (!electron?.generateUserStyle) {
      setError("AI generation isn't available in this build.");
      return;
    }
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await electron.generateUserStyle(target, generationInput);
        if (target === "full" || target === "optimize") {
          setFullGuide(res.markdown);
          setStep(3);
        } else {
          setCheatsheet(res.markdown);
          setStep(4);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Generation failed.");
      } finally {
        setBusy(false);
      }
    })();
  };

  const save = async () => {
    if (!fullGuide.trim() && !cheatsheet.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const source = samples.some((s) => s.context.startsWith("From your")) ? "analyzed" : "guided";
      await saveUserStyle({
        persona: {
          name: persona.name?.trim() || undefined,
          role: persona.role?.trim() || undefined,
          context: persona.context?.trim() || undefined,
          audiences: persona.audiences?.trim() || undefined,
        },
        fullGuide: fullGuide.trim(),
        cheatsheet: cheatsheet.trim(),
        source,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  const canProceed = (i: number) => {
    if (i === 0) return persona.name?.trim() || persona.role?.trim();
    if (i === 1) return samples.length > 0;
    if (i === 2) return true;
    return true;
  };

  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <span className="flex items-center gap-2">
          <PenLine size={16} /> {existing ? "Edit your writing style" : "Set up your writing style"}
        </span>
      }
      description="A short guided session — the assistant analyses your answers and builds a full style guide plus a condensed cheat sheet."
    >
      {/* Step indicator */}
      <div className="flex items-center gap-1.5 pb-3 border-b border-[var(--border)] flex-wrap">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className={cn(
                "text-[0.65rem] rounded-full px-2 py-0.5 border transition-colors",
                i === step
                  ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--text-primary)]"
                  : i < step
                    ? "border-[var(--border)] text-[var(--text-tertiary)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] opacity-60",
              )}
            >
              {i < step ? "✓ " : ""}{label}
            </span>
            {i < STEPS.length - 1 && <span className="text-[var(--text-tertiary)] text-[0.6rem]">→</span>}
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-3 text-[0.714rem] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="mt-4 space-y-3 min-h-[16rem]">
        {step === 0 && (
          <div className="space-y-3">
            <input className={inputCls} placeholder="Your name (e.g. Gerard)" value={persona.name ?? ""} onChange={(e) => setPersona({ ...persona, name: e.target.value })} />
            <input className={inputCls} placeholder="Role (e.g. Engineering lead at a health-tech startup)" value={persona.role ?? ""} onChange={(e) => setPersona({ ...persona, role: e.target.value })} />
            <textarea className={textareaCls} placeholder="Context — what do you build, what's your domain? (optional)" value={persona.context ?? ""} onChange={(e) => setPersona({ ...persona, context: e.target.value })} />
            <textarea className={textareaCls} placeholder="Who do you write to? (e.g. engineers, execs, customers, open-source contributors)" value={persona.audiences ?? ""} onChange={(e) => setPersona({ ...persona, audiences: e.target.value })} />
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-[0.714rem] text-[var(--text-tertiary)]">
              Paste 2–4 real messages — the more varied the better (a technical reply, a team DM, a formal email). Or pull from your notes and tasks.
            </p>
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Select
                  value={context}
                  options={CONTEXTS.map((c) => ({ value: c, label: c }))}
                  onChange={setContext}
                  size="sm"
                  ariaLabel="Message context"
                  className="w-44 flex-shrink-0"
                />
                <button
                  onClick={addNotesAsSamples}
                  className="px-2.5 py-2 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <FileText size={12} /> Analyse my notes &amp; tasks
                </button>
              </div>
              <textarea
                className={cn(textareaCls, "min-h-28")}
                placeholder="Paste a real message here…"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
              />
              <Button size="sm" disabled={!sampleText.trim()} onClick={addSample}>
                <Plus size={12} /> Add sample
              </Button>
            </div>

            {samples.length > 0 && (
              <div className="space-y-2">
                {samples.map((s, i) => (
                  <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{s.context}</span>
                      <button onClick={() => setSamples((prev) => prev.filter((_, j) => j !== i))} className="text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors">
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <p className="text-[0.65rem] text-[var(--text-secondary)] mt-1 whitespace-pre-wrap line-clamp-3">{s.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-[0.714rem] text-[var(--text-tertiary)]">
              A few quick questions on things your samples may not reveal. Skip any — the guide is still generated from what you give.
            </p>
            {GAP_QUESTIONS.map((q) => (
              <textarea
                key={q.id}
                className={textareaCls}
                placeholder={q.question}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              />
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[0.714rem] text-[var(--text-tertiary)]">
                The full writing style guide — generated from your answers. Optimize to restructure, or generate the condensed cheat sheet.
              </p>
              <button
                type="button"
                onClick={() => setPreviewMode((v) => !v)}
                className="shrink-0 text-[0.65rem] rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                {previewMode ? "Edit" : "Preview"}
              </button>
            </div>
            <GenerationStatus streaming={streaming} streamTools={streamTools} />
            {streaming ? (
              <textarea
                className={cn(textareaCls, "min-h-[22rem] font-mono text-[0.714rem]")}
                value={streamingText}
                readOnly
                placeholder="Generating…"
              />
            ) : previewMode ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 min-h-[22rem] max-h-[24rem] overflow-y-auto">
                <NoteMarkdownPreview content={fullGuide} inline />
              </div>
            ) : (
              <textarea
                className={cn(textareaCls, "min-h-[22rem] font-mono text-[0.714rem]")}
                value={fullGuide}
                onChange={(e) => setFullGuide(e.target.value)}
                placeholder="Paste or edit your full guide here…"
              />
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[0.714rem] text-[var(--text-tertiary)]">
                The condensed cheat sheet — a one-page reference. Edit, then save. Both are written to your writing style and exposed to chat &amp; the agent.
              </p>
              <button
                type="button"
                onClick={() => setPreviewMode((v) => !v)}
                className="shrink-0 text-[0.65rem] rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                {previewMode ? "Edit" : "Preview"}
              </button>
            </div>
            <GenerationStatus streaming={streaming} streamTools={streamTools} />
            {streaming ? (
              <textarea
                className={cn(textareaCls, "min-h-[18rem] font-mono text-[0.714rem]")}
                value={streamingText}
                readOnly
                placeholder="Generating…"
              />
            ) : previewMode ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 min-h-[18rem] max-h-[20rem] overflow-y-auto">
                <NoteMarkdownPreview content={cheatsheet} inline />
              </div>
            ) : (
              <textarea
                className={cn(textareaCls, "min-h-[18rem] font-mono text-[0.714rem]")}
                value={cheatsheet}
                onChange={(e) => setCheatsheet(e.target.value)}
                placeholder="Paste or edit your cheat sheet here…"
              />
            )}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--border)]">
        <Button variant="ghost" size="sm" disabled={busy} onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>
          {step === 0 ? "Cancel" : "Back"}
        </Button>
        <div className="flex items-center gap-2">
          {step === 0 && (
            <Button size="sm" disabled={!canProceed(0)} onClick={() => setStep(1)}>
              Next
            </Button>
          )}
          {step === 1 && (
            <Button size="sm" disabled={busy} onClick={() => setStep(2)}>
              Next
            </Button>
          )}
          {step === 2 && (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStep(3)}>
                Skip for now
              </Button>
              <Button size="sm" disabled={busy || !canProceed(0)} onClick={() => void generate("full")}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                Generate full guide
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStep(4)}>
                Skip for now
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || !fullGuide.trim()} onClick={() => void generate("optimize")}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                Optimize
              </Button>
              <Button size="sm" disabled={busy || !fullGuide.trim()} onClick={() => void generate("cheatsheet")}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                Generate cheat sheet
              </Button>
            </>
          )}
          {step === 4 && (
            <Button size="sm" disabled={busy || (!fullGuide.trim() && !cheatsheet.trim())} onClick={() => void save()}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} className="rotate-45" />}
              Save writing style
            </Button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * Live generation status — a "Generating…" pulse plus chips for each tool the
 * model called (e.g. searching/reading the user's notes on the analyse path).
 */
function GenerationStatus({ streaming, streamTools }: { streaming: boolean; streamTools: Array<{ tool: string; label: string; done: boolean }> }) {
  if (!streaming && streamTools.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {streaming && (
        <div className="flex items-center gap-1.5 text-[0.65rem] text-[var(--text-tertiary)]">
          <Loader2 size={11} className="animate-spin" /> Generating…
        </div>
      )}
      {streamTools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {streamTools.map((t, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[0.6rem] rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--text-secondary)]"
              title={t.tool}
            >
              {t.done ? (
                <Check size={10} className="text-[var(--success,var(--accent))]" />
              ) : (
                <Loader2 size={10} className="animate-spin" />
              )}
              {t.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
