/**
 * Bridge between the session IPC handlers and the Cairn-owned agent engine
 * (electron/agent). Sessions the retired engine harness wrote are imported on first touch.
 *
 * The implementation lives in `electron/ipc/engine/`; this file re-exports the
 * public surface so existing importers do not churn.
 */
export { chatEngineProfile, engineProfile, PERMISSION_PRESETS } from "../agent/profiles";

/** Re-exported so existing importers keep working; the home is `session-guards.ts`. */
export { rejectPrompt } from "./session-guards";

export { routeFromConfig } from "../agent/route";

export { PLAN_MODE_PROMPT, PLAN_MODE_ENDED, runEnginePrompt, type EnginePromptArgs } from "./engine/prompt";
export { readEnginePermissions, setEnginePermission, chatSystemPrompt, chatApprovalPolicyFor } from "./engine/permissions";
export { answerQuestion, listPendingQuestions, cancelQuestions } from "./engine/questions";
export { legacyRoot, removeLegacySessions, hostRoot } from "./engine/legacy-sessions";
export {
  getJobRegistry,
  getEngineHost,
  engineOwns,
  forgetEngineSession,
  destroyEngineSession,
  shutdownEngine,
} from "./engine/host";
export {
  readEngineGoal,
  listEngineSchedules,
  listEngineSubagents,
  interruptEngineSubagent,
  messageEngineSubagent,
} from "./engine/subagents";
export { runEngineChat, respondEngineAsk, compactEngineSession } from "./engine/entry-chat";
export { runEngineAutomation, runEngineTapped, type EngineAutomationArgs } from "./engine/entry-automation";
