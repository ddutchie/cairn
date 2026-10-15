/** AI helpers and usage statistics. */

import { invokeContract } from "./ipc";
import type { IpcArgs } from "../../shared/ipc/contract";
import type { AiEndpoint, AiRequestConfig, ModelPrice } from "../../shared/types/app";
import type { UsageRangeArgs } from "../../shared/types/usage";
import type { WireProtocol } from "../../shared/models/model-catalog";

export const aiApi = {
  // ── AI helpers ────────────────────────────────
  ai: {
    generatePrd: (args: IpcArgs<"ai:generatePrd">[0]) => invokeContract("ai:generatePrd", args),
    generateCommitMessage: (args: { diff: string; config: AiRequestConfig }) =>
      invokeContract("ai:generateCommitMessage", args),
    generatePrDescription: (args: { diff: string; config: AiRequestConfig; template?: string }) =>
      invokeContract("ai:generatePrDescription", args),
    explainArchitecture: (args: { summary: string; config: AiRequestConfig }) =>
      invokeContract("ai:explainArchitecture", args),
    fetchModels: (args: AiEndpoint) => invokeContract("ai:fetchModels", args),
    fetchKeyInfo: (args: AiEndpoint) => invokeContract("ai:fetchKeyInfo", args),
    /** Which wire protocols the endpoint offers for a model (no generation). */
    probeProtocols: (args: AiEndpoint & { model: string }) => invokeContract("ai:probeProtocols", args),
  },

  // ── Usage statistics (LLM/agent usage log) ─────
  usage: {
    overview: (args: UsageRangeArgs) => invokeContract("usage:overview", args),
    recent: (args: UsageRangeArgs & { limit?: number }) => invokeContract("usage:recent", args),
    threads: (args: UsageRangeArgs & { limit?: number }) => invokeContract("usage:threads", args),
    /** Destructive — delete recorded usage rows scoped to the workspace filter. */
    clear: (args: UsageRangeArgs) => invokeContract("usage:clear", args),
    /** Push the models.dev per-1M pricing map (used for cost estimation). */
    setPricing: (map: Record<string, ModelPrice>) => invokeContract("app:modelPricing", map),
    /** Push model ids that declare they don't support temperature control. */
    setNoTemperatureModels: (ids: string[]) => invokeContract("app:noTemperatureModels", ids),
    /** Push the per-model wire protocols for endpoints that dictate one (OpenCode). */
    setEndpointProtocols: (map: Record<string, WireProtocol>) => invokeContract("app:endpointProtocols", map),
  },
} as const;
