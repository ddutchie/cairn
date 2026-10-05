/**
 * User writing style (persona + full style guide + condensed cheat sheet),
 * stored in the single-row `user_style` table. Shared by the main-process
 * queries and generator, the typed IPC contract and the renderer.
 */

export type UserStyleSource = "none" | "guided" | "manual" | "analyzed";

export interface UserStylePersona {
  name?: string;
  role?: string;
  context?: string;
  audiences?: string;
}

export interface UserStyleRow {
  id: string;
  /** Serialized UserStylePersona JSON (parse defensively; absent = null). */
  persona: UserStylePersona | null;
  /** The long, section-structured writing style guide (markdown). */
  fullGuide: string;
  /** The condensed one-page cheat sheet (markdown). */
  cheatsheet: string;
  /** How the guide was produced: guided wizard / manual / analyzed / none. */
  source: UserStyleSource;
  updatedAt: string;
}

/** Upsert input; absent fields preserve the existing value. */
export interface UserStyleSaveInput {
  persona?: UserStylePersona;
  fullGuide?: string;
  cheatsheet?: string;
  source: UserStyleSource;
}

/** Which document a generation produces. */
export type UserStyleStep = "full" | "cheatsheet" | "optimize";

export interface UserStyleGenerationInput {
  persona: UserStylePersona;
  /** Sample messages pasted by the user, tagged by context. */
  samples: Array<{ context: string; text: string }>;
  /** Answers to the gap questions. */
  answers: Array<{ question: string; answer: string }>;
  /** Existing full guide — required for the "cheatsheet" and "optimize" steps. */
  fullGuide?: string;
}

/** `user-style:generateStream` request (fire-and-forget; progress arrives as events). */
export interface UserStyleStreamRequest {
  workspaceId?: string;
  projectId?: string;
  projectName?: string;
  step: UserStyleStep;
  analyseNotes: boolean;
  input: UserStyleGenerationInput;
}

export interface UserStyleToolCallEvent {
  tool: string;
  label: string;
  args: Record<string, unknown>;
}

export interface UserStyleToolCallDoneEvent {
  tool: string;
  ok?: boolean;
  error?: string;
}

export interface UserStyleDoneEvent {
  content: string;
  usable: boolean;
  error?: string;
}
