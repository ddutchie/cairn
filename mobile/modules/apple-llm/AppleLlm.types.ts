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
