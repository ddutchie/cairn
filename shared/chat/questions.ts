/**
 * `ask_questions`: the questions the model sends, checked, and the answers a
 * person gives, as the text the tool returns to the model (one
 * `**Label:** answer` line per question, the same as desktop's form).
 */

export interface AskQuestion {
  id: string;
  label: string;
  prompt: string;
}

/** Most questions one card shows; the schema asks for 2–4. */
export const MAX_QUESTIONS = 6;

/** The model's `questions` argument as clean questions, or an error to send back. */
export function parseQuestions(raw: unknown): { questions: AskQuestion[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "questions must be a non-empty array of { id, label, prompt }" };
  const seen = new Set<string>();
  const questions: AskQuestion[] = [];
  raw.slice(0, MAX_QUESTIONS).forEach((q, i) => {
    const o = (q ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const label = text(o.label) || text(o.prompt).slice(0, 60);
    const prompt = text(o.prompt);
    if (!label && !prompt) return;
    let id = text(o.id) || `q${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    questions.push({ id, label: label || prompt, prompt: prompt === label ? "" : prompt });
  });
  return questions.length > 0 ? { questions } : { error: "every question needs a label or a prompt" };
}

/** Answers keyed by question id, as the tool result text. A blank answer reads "(no answer)". */
export function formatAnswers(questions: readonly AskQuestion[], answers: Readonly<Record<string, string>>): string {
  // Own properties only: a question id like "constructor" must not read an inherited function.
  const answerFor = (id: string): string => {
    const a = Object.prototype.hasOwnProperty.call(answers, id) ? answers[id] : undefined;
    return typeof a === "string" ? a.trim() : "";
  };
  return questions.map((q) => `**${q.label}:** ${answerFor(q.id) || "(no answer)"}`).join("\n");
}
