import { NativeModule, requireOptionalNativeModule } from "expo";

import type {
  AppleGenerateOptions,
  AppleLlmEvents,
  AppleTool,
} from "./AppleLlm.types";

export * from "./AppleLlm.types";

/**
 * Native surface of the `apple-llm` module. Extends NativeModule so it inherits
 * `addListener`/`removeListener` for the streaming events. All FoundationModels
 * use is iOS 26+ and gated natively — the JS layer must call `isAvailable()`
 * first and fall back gracefully everywhere else (simulator, Android, web).
 */
declare class AppleLlmNativeModule extends NativeModule<AppleLlmEvents> {
  /** True only on an iOS 26+ device with Apple Intelligence enabled and ready. */
  isAvailable(): boolean;
  /** Human-readable reason when unavailable (empty when available). */
  unavailableReason(): string;
  /** Best-effort token count (-1 when unavailable). */
  countTokens(text: string): Promise<number>;
  /**
   * Start a streaming generation on the persistent session `sessionId` with
   * native tool-calling. The session keeps the transcript, so `prompt` is just
   * the newest user turn. Resolves immediately; consume via `onToken` /
   * `onToolCall` / `onDone` / `onError` events (tokens/done/error keyed by
   * `requestId`, tool calls by `sessionId`). When the model calls a tool, an
   * `onToolCall` fires — execute it and answer with `resolveToolCall` to resume.
   */
  generate(
    requestId: string,
    sessionId: string,
    prompt: string,
    tools: AppleTool[],
    options: AppleGenerateOptions,
  ): Promise<void>;
  /** Drop a persistent session so the next generate() gets a fresh context window. */
  resetSession(sessionId: string): void;
  /** Warm the model for a session to cut first-token latency. Best-effort. */
  prewarm(sessionId: string, system: string | undefined, tools: AppleTool[]): void;
  /**
   * Resume a suspended tool call. Pass the tool result as a JSON string, or a
   * non-empty `errorMessage` to fail the call.
   */
  resolveToolCall(callId: string, resultJson: string, errorMessage?: string): void;
  /** Cancel an in-flight generation by id. */
  cancel(requestId: string): void;
}

/**
 * The native module, or null when it isn't present (Expo Go, web, a build that
 * didn't include the module). Optional so importing this file never throws on
 * unsupported platforms — always guard with `isAppleLlmAvailable()`.
 */
export const AppleLlm = requireOptionalNativeModule<AppleLlmNativeModule>("AppleLlm");

/** Whether on-device Apple Foundation Models can run right now. */
export function isAppleLlmAvailable(): boolean {
  try {
    return AppleLlm?.isAvailable() ?? false;
  } catch {
    return false;
  }
}

/** Reason the on-device model is unavailable, for surfacing in the UI. */
export function appleLlmUnavailableReason(): string {
  try {
    if (!AppleLlm) return "On-device AI isn't available in this build.";
    return AppleLlm.unavailableReason() || "Apple Intelligence is unavailable.";
  } catch {
    return "On-device AI isn't available on this device.";
  }
}
