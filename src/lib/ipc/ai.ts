/**
 * Typed clients for AI helpers (`ai:*`) and usage statistics (`usage:*`,
 * `app:modelPricing`, `app:noTemperatureModels`, `app:endpointProtocols`).
 * Every failure rejects with the main-process message; off-Electron calls
 * reject with `IpcUnavailableError`.
 */
import type { IpcArgs } from "../../../shared/ipc/contract";
import type { AiEndpoint, AiRequestConfig, ModelPrice } from "../../../shared/types/app";
import type { UsageRangeArgs } from "../../../shared/types/usage";
import type { WireProtocol } from "../../../shared/models/model-catalog";
import { domainCall, type ElectronApi } from "./client";

type AiApi = NonNullable<ElectronApi["ai"]>;
const ai = <T>(fn: (api: AiApi) => Promise<T>) => domainCall("ai", fn);

export const aiClient = {
  generatePrd: (args: IpcArgs<"ai:generatePrd">[0]) => ai((a) => a.generatePrd(args)),
  generateCommitMessage: (args: { diff: string; config: AiRequestConfig }) =>
    ai((a) => a.generateCommitMessage(args)),
  generatePrDescription: (args: { diff: string; config: AiRequestConfig; template?: string }) =>
    ai((a) => a.generatePrDescription(args)),
  explainArchitecture: (args: { summary: string; config: AiRequestConfig }) =>
    ai((a) => a.explainArchitecture(args)),
  fetchModels: (args: AiEndpoint) => ai((a) => a.fetchModels(args)),
  fetchKeyInfo: (args: AiEndpoint) => ai((a) => a.fetchKeyInfo(args)),
  /** Which wire protocols the endpoint offers for a model (no generation). */
  probeProtocols: (args: AiEndpoint & { model: string }) => ai((a) => a.probeProtocols(args)),
};

type UsageApi = NonNullable<ElectronApi["usage"]>;
const usage = <T>(fn: (api: UsageApi) => Promise<T>) => domainCall("usage", fn);

/** Usage statistics (LLM/agent usage log). */
export const usageClient = {
  overview: (args: UsageRangeArgs) => usage((u) => u.overview(args)),
  recent: (args: UsageRangeArgs & { limit?: number }) => usage((u) => u.recent(args)),
  threads: (args: UsageRangeArgs & { limit?: number }) => usage((u) => u.threads(args)),
  /** Destructive — delete recorded usage rows scoped to the workspace filter. */
  clear: (args: UsageRangeArgs) => usage((u) => u.clear(args)),
  /** Push the models.dev per-1M pricing map (used for cost estimation). */
  setPricing: (map: Record<string, ModelPrice>) => usage((u) => u.setPricing(map)),
  /** Push model ids that declare they don't support temperature control. */
  setNoTemperatureModels: (ids: string[]) => usage((u) => u.setNoTemperatureModels(ids)),
  /** Push the per-model wire protocols for endpoints that dictate one (OpenCode). */
  setEndpointProtocols: (map: Record<string, WireProtocol>) => usage((u) => u.setEndpointProtocols(map)),
};
