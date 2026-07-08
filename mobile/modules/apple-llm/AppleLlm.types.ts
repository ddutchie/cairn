/**
 * Types for the on-device Apple Foundation Models native module (`apple-llm`).
 * These mirror the Swift `Record` shapes in ios/AppleLlmModule.swift.
 */

/** A chat turn passed to the native model. `system` is folded into instructions. */
export interface AppleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * A tool the model may call. `jsonSchema` is the arguments' JSON Schema encoded
 * as a JSON string (passed as a string to avoid arbitrary-object bridging).
 */
export interface AppleTool {
  name: string;
  description: string;
  jsonSchema: string;
}

/** Generation tuning. `system` overrides any system-role message in `messages`. */
export interface AppleGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  system?: string;
  /**
   * Route through Private Cloud Compute (server model, iOS 27+) instead of the
   * on-device model. Falls back to on-device automatically below iOS 27 or when
   * PCC is unavailable.
   */
  useServer?: boolean;
  /**
   * PCC reasoning effort. Ignored on-device / when omitted (model default).
   * Deeper reasoning trades latency + context for stronger multi-step analysis.
   */
  reasoningLevel?: AppleReasoningLevel;
}

/** PCC reasoning-effort levels (iOS 27+). */
export type AppleReasoningLevel = "light" | "moderate" | "deep";

/** PCC daily-quota snapshot (from `quotaStatus()`). */
export interface AppleQuotaStatus {
  /** False when PCC/iOS 27 isn't present — callers should hide quota UI. */
  available: boolean;
  status: "below" | "approaching" | "exceeded" | "unknown";
  isLimitReached: boolean;
  /** Whether an iCloud+ upgrade suggestion can be presented. */
  canUpgrade: boolean;
  /** ISO8601 quota-reset date, or "" when unknown / well below the limit. */
  resetDate: string;
}

/** Streaming events emitted by the native module, keyed by `requestId`. */
export interface AppleTokenEvent {
  requestId: string;
  delta: string;
}
export interface AppleDoneEvent {
  requestId: string;
  finishReason: string;
}
export interface AppleErrorEvent {
  requestId: string;
  code: AppleLLMErrorCode;
  message: string;
}
/**
 * The model called a tool. Execute it in JS, then call `resolveToolCall(callId,
 * resultJson)` (or with an error message) to resume the suspended native turn.
 * Routed by `sessionId` (a session has one active generation at a time).
 * `input` is the model-generated arguments as a JSON string.
 */
export interface AppleToolCallEvent {
  sessionId: string;
  callId: string;
  toolName: string;
  input: string;
}

export type AppleLlmEvents = {
  onToken: (e: AppleTokenEvent) => void;
  onDone: (e: AppleDoneEvent) => void;
  onError: (e: AppleErrorEvent) => void;
  onToolCall: (e: AppleToolCallEvent) => void;
};

/**
 * Stable public error codes. Use `code` for control flow; `message` is
 * display/debug text, not a compatibility contract.
 */
export const AppleLLMErrorCodes = {
  ModelUnavailable: "MODEL_UNAVAILABLE",
  UnsupportedOS: "UNSUPPORTED_OS",
  GenerationError: "GENERATION_ERROR",
  InvalidMessage: "INVALID_MESSAGE",
  InvalidSchema: "INVALID_SCHEMA",
  ToolCallError: "TOOL_CALL_ERROR",
  ContextWindowExceeded: "CONTEXT_WINDOW_EXCEEDED",
  Cancelled: "CANCELLED",
  /** Private Cloud Compute daily request quota reached (iOS 27+). */
  QuotaExceeded: "QUOTA_EXCEEDED",
  /** PCC request failed with no network (PCC is online-only). */
  NetworkUnavailable: "NETWORK_UNAVAILABLE",
} as const;

export type AppleLLMErrorCode =
  (typeof AppleLLMErrorCodes)[keyof typeof AppleLLMErrorCodes];

/** An Error thrown/emitted by the native module, carrying a stable `code`. */
export class AppleLLMError extends Error {
  code: AppleLLMErrorCode;
  constructor(code: AppleLLMErrorCode, message: string) {
    super(message);
    this.name = "AppleLLMError";
    this.code = code;
  }
}
