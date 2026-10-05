/** User writing style (Settings → Writing Style). */

import { invokeContract, onIpcEvent, sendContract } from "./ipc";
import type { UserStyleDoneEvent, UserStyleGenerationInput, UserStyleSaveInput, UserStyleStep, UserStyleStreamRequest, UserStyleToolCallDoneEvent, UserStyleToolCallEvent } from "../../shared/types/user-style";

export const userStyleApi = {
  // User writing style (persona + full guide + cheat sheet) — Settings → Writing Style.
  getUserStyle: () => invokeContract("user-style:get"),
  saveUserStyle: (input: UserStyleSaveInput) => invokeContract("user-style:save", { input }),
  clearUserStyle: () => invokeContract("user-style:clear"),
  generateUserStyle: (step: UserStyleStep, input: UserStyleGenerationInput) =>
    invokeContract("user-style:generate", { step, input }),
  // Streaming generation (wizard) — fire-and-forget; listen via onUserStyle*.
  // Credentials are resolved main-side (resolveChatConfig), never sent here.
  generateUserStyleStream: (req: UserStyleStreamRequest) => sendContract("user-style:generateStream", req),
  abortUserStyleStream: () => sendContract("user-style:abort"),
  onUserStyleToken: (cb: (e: { delta: string }) => void) => onIpcEvent("user-style:token", cb),
  onUserStyleToolCall: (cb: (e: UserStyleToolCallEvent) => void) => onIpcEvent("user-style:tool-call", cb),
  onUserStyleToolCallDone: (cb: (e: UserStyleToolCallDoneEvent) => void) => onIpcEvent("user-style:tool-call-done", cb),
  onUserStyleDone: (cb: (e: UserStyleDoneEvent) => void) => onIpcEvent("user-style:done", cb),
} as const;
