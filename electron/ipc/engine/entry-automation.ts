/**
 * Headless entry points: automations and tapped runs. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; no logic changes.)
 */
import type { HostSend } from "../../agent/host";
import { forgetEngineSession, releaseEngineSession } from "./host";
import { runEnginePrompt, type EnginePromptArgs } from "./prompt";
import { sessionTaps } from "./session-state";

export interface EngineAutomationArgs extends Omit<EnginePromptArgs, "chat" | "role" | "usageSource" | "profile"> {
  /** Every event and projection of the run goes here instead of to the renderer. */
  tap: HostSend;
  /** Unattended mode: `yolo` when approvals are automatic, otherwise every ask reaches the tap. */
  autoApprove: boolean;
}

/** A headless coding run (automations): same engine and tools, events delivered to `tap` only. */
export async function runEngineAutomation(a: EngineAutomationArgs): Promise<void> {
  sessionTaps.set(a.sessionId, a.tap);
  try {
    await runEnginePrompt({
      ...a,
      usageSource: "automation",
      forceSandbox: true,
      noQuestions: true,
      profile: { id: "automation", interactive: true, mode: a.autoApprove ? "yolo" : "ask", externalAlwaysAsks: a.autoApprove },
    });
  } finally {
    sessionTaps.delete(a.sessionId);
    // Nothing will clear an unattended run later: stop what it left running and drop its in-memory state.
    forgetEngineSession(a.sessionId);
    releaseEngineSession(a.sessionId);
  }
}

/** A run whose events go to `tap` instead of the renderer (internal wizards). */
export async function runEngineTapped(a: Omit<EnginePromptArgs, "role" | "profile"> & { tap: HostSend }): Promise<void> {
  sessionTaps.set(a.sessionId, a.tap);
  try {
    await runEnginePrompt(a);
  } finally {
    sessionTaps.delete(a.sessionId);
  }
}
