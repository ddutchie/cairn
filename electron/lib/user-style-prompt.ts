/**
 * System prompts for the Writing Style guided generator.
 *
 * Step 1 ("full") analyzes the user's persona, pasted sample messages, and
 * answers to the gap questions, and produces the FULL writing style guide —
 * structured into the canonical section taxonomy (rhythm, tone/register,
 * openings/closings, punctuation, vocabulary, feedback, emoji, formatting,
 * anti-patterns, range). Step 2 ("cheatsheet") condenses the full guide into
 * a one-page drafting reference.
 *
 * Both prompts demand markdown only, no preamble, so the output can be saved
 * verbatim. The anti-pattern rule (no em-dashes) is deliberately the strongest
 * signal: it is the canonical "AI tell" the whole feature exists to prevent.
 */

export interface UserStyleGenerationInput {
  persona: {
    name?: string;
    role?: string;
    context?: string;
    audiences?: string;
  };
  /** Sample messages pasted by the user, tagged by context. */
  samples: Array<{ context: string; text: string }>;
  /** Answers to the gap questions. */
  answers: Array<{ question: string; answer: string }>;
  /** Existing full guide — required for the "cheatsheet" step. */
  fullGuide?: string;
}

const PERSONA_BLOCK = (p: UserStyleGenerationInput["persona"]) => {
  const parts = [
    p.name ? `Name: ${p.name}` : "",
    p.role ? `Role: ${p.role}` : "",
    p.context ? `Context: ${p.context}` : "",
    p.audiences ? `Audiences: ${p.audiences}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : "(none provided)";
};

/** Build the system prompt for generating the FULL writing style guide. */
export function buildUserStyleFullGuidePrompt(input: UserStyleGenerationInput): string {
  // Bound the raw material: a pasted document (e.g. an existing style guide)
  // can run tens of thousands of chars and drown a smaller model — truncate
  // each sample and cap the combined block so the analysis prompt stays
  // digestible. Truncation is lossy but the style *signals* survive.
  const MAX_SAMPLE_CHARS = 2000;
  const MAX_TOTAL_CHARS = 12_000;
  let total = 0;
  const bounded: string[] = [];
  for (const s of input.samples) {
    const text = s.text.slice(0, MAX_SAMPLE_CHARS);
    if (total + text.length > MAX_TOTAL_CHARS) {
      bounded.push(`### ${s.context}\n${text.slice(0, Math.max(0, MAX_TOTAL_CHARS - total))}`);
      break;
    }
    total += text.length;
    bounded.push(`### ${s.context}\n${text}`);
  }
  const samples = bounded.length
    ? bounded.join("\n\n")
    : "(no samples provided)";
  const answers = input.answers.length
    ? input.answers.map((a) => `- ${a.question}: ${a.answer || "(no answer)"}`).join("\n")
    : "(no answers provided)";

  return `You are a writing-style analyst. Analyse the user's real messages and answers below and produce a complete "Writing Style Guide" — a reference document an AI can use to draft content that sounds like the user.

Follow this exact structure, with ## headings. Write EVERY section, but keep the whole document focused and evidence-based — quote the user's own words as examples where possible. Do not invent traits that the evidence contradicts; mark uncertain items as such.

## 1. Voice in one line
## 2. Sentence Length & Rhythm
## 3. Tone & Register
## 4. Openings & Closings
## 5. Punctuation Habits
## 6. Vocabulary & Phrases (signature phrases, then "Avoid")
## 7. How I Give Feedback or Disagree
## 8. Emoji Use
## 9. Formatting
## 10. Other Distinctive Patterns
## 11. Anti-Patterns — Does NOT Sound Like Me
## 12. Preserve These Voice Tells

Rules:
- Output ONLY the markdown guide. No preamble, no commentary, no code fence.
- The "Anti-Patterns" section must be explicit and specific (e.g. a hard rule like "never use em-dashes (—), use a plain hyphen" if that matches the evidence).
- "Preserve These Voice Tells" lists quirks to KEEP when drafting (dropped apostrophes, dropped question marks, spelling variants) — only if present in the samples.
- Base everything on the samples and answers. If the user pasted technical and casual messages, capture the register range across contexts.

## Persona
${PERSONA_BLOCK(input.persona)}

## Sample messages (real writing)
${samples}

## Answers to style questions
${answers}`;
}

/** Build the system prompt for condensing the full guide into the cheat sheet. */
export function buildUserStyleCheatsheetPrompt(fullGuide: string): string {
  return `You are an editor. Condense the Writing Style Guide below into a one-page "Cheat Sheet" — a quick drafting reference the user can glance at while an AI writes in their voice.

Requirements:
- Output ONLY markdown. No preamble, no commentary, no code fence.
- Lead with a "Voice in one line" (a single sentence) and a "Two gears" line if the guide describes context-dependent registers.
- Keep the highest-signal rules under tight subsections: Rhythm, Tone & Register, Openings & Closings, Questions & Requests, Feedback & Mistakes, Signature Phrases, Formatting, Emoji.
- Keep an "⚠️ Anti-Patterns (instant tells — never do)" section VERBATIM in spirit — the no-em-dash rule (or equivalent) must survive intact, worded as a hard rule.
- Keep a "Preserve (don't 'fix')" line for the listed voice tells.
- Aim for roughly a third of the original length. Quotes/examples should be one-liners.

## Writing Style Guide
${fullGuide}`;
}

/** Build the system prompt for optimizing/restructuring an EXISTING full guide. */
export function buildUserStyleOptimizePrompt(fullGuide: string): string {
  return `You are an editor optimizing an existing writing style guide. Restructure the guide below into the canonical 12-section format so an AI can use it to draft in the user's voice. Produce ONLY the optimized guide, in clean Markdown with ## headings.

## Canonical structure (use exactly these headings)
## 1. Voice in one line
## 2. Sentence Length & Rhythm
## 3. Tone & Register
## 4. Openings & Closings
## 5. Punctuation Habits
## 6. Vocabulary & Phrases
## 7. How I Give Feedback or Disagree
## 8. Emoji Use
## 9. Formatting
## 10. Other Distinctive Patterns
## 11. Anti-Patterns — Does NOT Sound Like Me
## 12. Preserve These Voice Tells

Rules:
- Preserve every concrete, evidence-based detail from the source; move each into its matching section.
- Keep signature phrases, quoted examples, and the emoji lexicon verbatim.
- Keep the Anti-Patterns section explicit and hard (e.g. "never use em-dashes — use a plain hyphen" if that's a rule).
- Fill genuinely missing sections with a short "Uncertain — not covered in the source." line rather than inventing traits.
- Do NOT invent style traits the source doesn't support.
- Output ONLY the optimized guide. No preamble, no commentary, no code fence.

## Existing guide to optimize
${fullGuide}`;
}
