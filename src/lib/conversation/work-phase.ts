/**
 * What the assistant is doing while a turn is in flight. Each phase gets its own loader
 * (`WorkLoader`), so "waiting for the model", "reasoning" and "writing the answer" don't all
 * look like the same blinking caret.
 */
export type WorkPhase =
  | "sending"    // request is out, nothing back yet
  | "thinking"   // reasoning is streaming
  | "responding" // answer text is streaming
  | "tools"      // a tool call is running
  | "working"    // busy, but nothing finer is known (composer strip, transcript footer)
  | "retrying"   // a transient failure is being retried
  | "compacting" // the context is being summarised
  | "waiting";   // blocked on the user (approval or question)

/** The phase of a streaming assistant turn, from what it has produced so far. */
export function streamingPhase(turn: { hasContent: boolean; hasReasoning: boolean; toolRunning: boolean }): WorkPhase {
  if (turn.toolRunning) return "tools";
  if (turn.hasContent) return "responding";
  if (turn.hasReasoning) return "thinking";
  return "sending";
}

/**
 * The phase for a surface that doesn't follow the live text (composer strip, transcript footer).
 * Blocking states win over the generic one.
 */
export function overallPhase(state: { retrying?: boolean; compacting?: boolean; waiting?: boolean }): WorkPhase {
  if (state.waiting) return "waiting";
  if (state.compacting) return "compacting";
  if (state.retrying) return "retrying";
  return "working";
}
