/**
 * AI text-action definitions + prompt builder, shared by the desktop and mobile
 * note editors. Pure — no UI, no platform deps. The desktop toolbar and the
 * mobile toolbar both build their action rows from AI_ACTIONS and send
 * buildAIActionPrompt() to their respective LLM transports (Electron chat IPC /
 * Rork stream). The result replaces the user's current selection.
 */

export type AITextAction =
  | "rephrase"
  | "summarize"
  | "expand"
  | "fix_grammar"
  | "change_tone"
  | "custom";

export const AI_ACTIONS: { id: AITextAction; label: string }[] = [
  { id: "rephrase", label: "Rephrase" },
  { id: "summarize", label: "Summarize" },
  { id: "expand", label: "Expand" },
  { id: "fix_grammar", label: "Fix grammar" },
  { id: "change_tone", label: "Change tone" },
  { id: "custom", label: "Custom" },
];

/** Build the instruction prompt for an AI text action over `selectedText`. */
export function buildAIActionPrompt(
  action: AITextAction,
  selectedText: string,
  customPrompt?: string,
): string {
  const base =
    `You are an AI writing assistant embedded in a note editor. The user has selected the following text:\n\n"${selectedText}"\n\n## RENDERING CAPABILITIES:\n` +
    "- You have access to the following markdown rendering features:\n" +
    "  - **Mermaid Diagrams**: Use ```mermaid``` blocks for flowcharts, sequence diagrams, etc.\n" +
    "  - **Tables**: Use standard markdown table syntax for data representation.\n" +
    "  - **Code Blocks**: Specify the language (e.g., ```typescript```) for syntax highlighting.\n" +
    "  - **Standard Formatting**: Bold, italic, bulleted/numbered lists, and links.\n\n";
  switch (action) {
    case "rephrase":
      return base + "Rephrase this text to say the same thing in a different, clearer way. Return only the rewritten text, no commentary.";
    case "summarize":
      return base + "Summarize this text concisely. Return only the summary, no commentary.";
    case "expand":
      return base + "Expand this text with more detail and depth. Return only the expanded text, no commentary.";
    case "fix_grammar":
      return base + "Fix any grammar, spelling, and punctuation errors in this text. Return only the corrected text, no commentary.";
    case "change_tone":
      return base + "Rewrite this text in a more professional and polished tone. Return only the rewritten text, no commentary.";
    case "custom":
      return base + `${customPrompt}. Return only the resulting text, no commentary.`;
  }
}
