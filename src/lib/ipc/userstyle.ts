/**
 * Typed client for the user writing style (`user-style:*`). These live at the
 * top level of the bridge (no namespace object). Streaming generation is
 * fire-and-forget; results arrive via the onUserStyle* subscriptions.
 * Every failure rejects with the main-process message; off-Electron calls
 * reject with `IpcUnavailableError`.
 */
import type {
  UserStyleDoneEvent,
  UserStyleGenerationInput,
  UserStyleSaveInput,
  UserStyleStep,
  UserStyleStreamRequest,
  UserStyleToolCallDoneEvent,
  UserStyleToolCallEvent,
} from "../../../shared/types/user-style";
import { electronCall } from "./client";

export const userStyleClient = {
  getUserStyle: () => electronCall((e) => e.getUserStyle()),
  saveUserStyle: (input: UserStyleSaveInput) => electronCall((e) => e.saveUserStyle(input)),
  clearUserStyle: () => electronCall((e) => e.clearUserStyle()),
  generateUserStyle: (step: UserStyleStep, input: UserStyleGenerationInput) =>
    electronCall((e) => e.generateUserStyle(step, input)),
  /** Streaming generation (wizard) — fire-and-forget; listen via onUserStyle*. */
  generateUserStyleStream: (req: UserStyleStreamRequest): Promise<void> =>
    electronCall((e) => { e.generateUserStyleStream(req); return Promise.resolve(); }),
  abortUserStyleStream: (): Promise<void> =>
    electronCall((e) => { e.abortUserStyleStream(); return Promise.resolve(); }),
  onUserStyleToken: (cb: (e: { delta: string }) => void): (() => void) =>
    window.electron?.onUserStyleToken?.(cb) ?? (() => {}),
  onUserStyleToolCall: (cb: (e: UserStyleToolCallEvent) => void): (() => void) =>
    window.electron?.onUserStyleToolCall?.(cb) ?? (() => {}),
  onUserStyleToolCallDone: (cb: (e: UserStyleToolCallDoneEvent) => void): (() => void) =>
    window.electron?.onUserStyleToolCallDone?.(cb) ?? (() => {}),
  onUserStyleDone: (cb: (e: UserStyleDoneEvent) => void): (() => void) =>
    window.electron?.onUserStyleDone?.(cb) ?? (() => {}),
};
