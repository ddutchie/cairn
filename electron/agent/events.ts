/**
 * AgentEvent — the only thing the loop emits. The session log is an append of
 * these events and every projection (live UI, replay, stats) is a fold over
 * them. See docs/plans/agent-engine-design.md §1.
 */
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import type { AskSpec } from "./gate";
import type { GrantKind, RiskClass, Rule } from "./rules";

export type DecisionSource = "profile" | "plan" | "rule" | "doom" | "protected" | "default" | "mode" | "human" | "reviewer" | "timeout" | "abort" | "headless";

export type TurnEndReason = "stop" | "aborted" | "error" | "max-steps" | "overflow";

/** An image the user attached; `data` is base64. */
export interface UserImage { mediaType: string; data: string; name?: string }

export type AgentEvent =
  | { type: "turn/start"; sessionId: string; profile: string }
  | { type: "user/message"; content: string; images?: UserImage[] }
  | { type: "assistant/delta"; text: string }
  | { type: "assistant/thinking"; text: string }
  | { type: "assistant/message"; message: AssistantMessage }
  | { type: "tool/call"; callId: string; name: string; args: JsonObject; risk: RiskClass }
  | { type: "approval/asked"; ask: AskSpec }
  | { type: "approval/decided"; callId: string; approved: boolean; by: DecisionSource; reason?: string; ruleId?: string; grant?: GrantKind }
  | { type: "rule/added"; rule: Rule }
  | { type: "tool/result"; callId: string; name: string; text: string; isError: boolean }
  | { type: "auto/paused"; reason: string }
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; error: string }
  | { type: "context/overflow" }
  | { type: "compaction"; summary: string; keepCount: number; tokensBefore: number; trigger: "threshold" | "overflow" | "manual" }
  | { type: "session/title"; title: string }
  | { type: "error"; message: string }
  | { type: "turn/end"; reason: TurnEndReason };
