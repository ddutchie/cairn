/**
 * Shared approval state — the single source of truth for HITL approvals.
 *
 * Both the chat and coding loops mount `cairnApprovalPlugin`, which registers
 * pending approvals keyed `${sessionId}::${callId}`. The renderer answers via
 * `session:respond-tool`, which resolves the stored resolver plus the nonce and
 * pending-ask metadata (for tool-name binding and workspace-grant persistence).
 *
 * Before Stage 3 this state lived entirely in `session-runtime-handlers.ts`
 * and so chat could not participate — `session:respond-tool`'s global handler
 * would find an empty map for `chat-*` sessions. Extracting it here makes the
 * handler profile-agnostic.
 */

import { createPendingAskRegistry, type PendingAskRegistry } from "../cordis/approval-grants";

// Re-export the nonce store through here so chat and the global
// session:respond-tool handler are guaranteed to share the SAME Map
// instance. Importing ask-nonce.ts directly from two IPC modules can
// produce two distinct Maps under Electron's ESM/CJS interop, which is
// exactly what caused chat approvals to mint a nonce that the verifier
// never saw (expected=undefined).
export {
  mintAskNonce,
  verifyAskNonce,
  dropAskNonce,
  clearAskNoncesForSession,
  getAskNonce,
  _debugNonceKeys,
} from "./ask-nonce";

export const cordisPendingApprovals = new Map<string, (decision: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void>();
export const pendingKey = (sessionId: string, callId: string): string => `${sessionId}::${callId}`;
export const pendingAsks: PendingAskRegistry = createPendingAskRegistry();
