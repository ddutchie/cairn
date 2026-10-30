/**
 * Auto-mode reviewer contract + escalation state. The model-backed stages and
 * input guard come later; the loop only depends on this seam.
 * See docs/plans/agent-engine-design.md §5.
 */
import type { RiskInfo } from "./rules";

export interface ReviewRequest {
  sessionId: string;
  callId: string;
  tool: string;
  args: unknown;
  risk: RiskInfo;
  signal?: AbortSignal;
}

export interface Verdict {
  verdict: "allow" | "block" | "ask";
  /** ≤ 200 chars; shown to the user and, for `block`, returned to the model. */
  reason: string;
  tags?: string[];
}

export type Reviewer = (req: ReviewRequest) => Promise<Verdict>;

export const MAX_CONSECUTIVE_BLOCKS = 3;
export const MAX_TOTAL_BLOCKS = 20;

/** Survives across turns of one session. */
export interface ReviewerState {
  consecutiveBlocks: number;
  totalBlocks: number;
  paused: boolean;
}

export function createReviewerState(): ReviewerState {
  return { consecutiveBlocks: 0, totalBlocks: 0, paused: false };
}

/** Record a verdict; returns a pause reason when escalation just triggered. */
export function recordVerdict(state: ReviewerState, verdict: Verdict["verdict"]): string | undefined {
  if (verdict === "block") {
    state.consecutiveBlocks++;
    state.totalBlocks++;
    if (!state.paused && state.consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
      state.paused = true;
      return `${MAX_CONSECUTIVE_BLOCKS} consecutive blocks`;
    }
    if (!state.paused && state.totalBlocks >= MAX_TOTAL_BLOCKS) {
      state.paused = true;
      return `${MAX_TOTAL_BLOCKS} blocks this session`;
    }
  } else if (verdict === "allow") {
    state.consecutiveBlocks = 0;
  }
  return undefined;
}
