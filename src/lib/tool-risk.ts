/**
 * Renderer re-exports of the canonical tool-risk taxonomy
 * (shared/agent/tool-risk.ts). The classification used to live here while the
 * main-process approval gate kept its own list — they drifted. Single source
 * now; keep this file a thin facade so renderer imports stay stable.
 */
export {
  APPROVAL_SAFE_TOOLS,
  needsApproval,
  riskForTool,
  approvalPreview,
  approvalGrantScope,
  approvalScopeLabel,
  type RiskClass,
  type GrantScope,
} from "../../shared/agent/tool-risk";
