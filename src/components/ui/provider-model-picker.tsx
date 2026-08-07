"use client";

/**
 * ProviderModelPicker — a compact "who am I talking to?" control that shows the
 * active provider · model and lets you browse EVERY connected provider (the
 * shared saved-provider list) and switch model on the fly. Targets either the
 * AI Chat config or the Agent config (each keeps its own active provider/model).
 *
 * Rendered ABOVE the input box in Chat, the Agent pane, and the Overview's
 * pinned chat input, so the choice is always reachable — including while the
 * chat panel is collapsed.
 */

import { useState, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { ModelPicker } from "@/components/ui/model-picker";
import { useEndpointConfig, isLocalBaseUrl } from "@/components/settings/endpoint-components";

export interface ProviderModelPickerProps {
  /** Which surface's config this edits — AI Chat or the coding agent. */
  target: "ai" | "agent";
  disabled?: boolean;
  align?: "start" | "center" | "end";
  /** Density for the trigger chip. "xs" = input footer; "sm" = headers. */
  size?: "xs" | "sm";
  className?: string;
}

export function ProviderModelPicker({
  target,
  disabled,
  align = "end",
  size = "sm",
  className,
}: ProviderModelPickerProps) {
  const { aiConfig, agentConfig, selectSavedProvider, selectAgentProvider, setAIConfig, setAgentConfig } = useCairnStore(
    useShallow((s) => ({
      aiConfig: s.aiConfig,
      agentConfig: s.agentConfig,
      selectSavedProvider: s.selectSavedProvider,
      selectAgentProvider: s.selectAgentProvider,
      setAIConfig: s.setAIConfig,
      setAgentConfig: s.setAgentConfig,
    })),
  );

  const { availableModels, modelsLoading, testState, ensureModels, fetchModels } = useEndpointConfig();

  const config = target === "ai" ? aiConfig : agentConfig;
  const savedProviders = aiConfig.savedProviders ?? [];
  const activeProvider = savedProviders.find((p) => p.id === config.activeProviderId);
  // On-device (Llama) is a chat-only target; the agent always uses a saved provider.
  const isLocal = target === "ai" && aiConfig.provider === "localllm";

  const providerLabel = isLocal
    ? "On-device"
    : activeProvider?.name ?? config.activeProviderId ?? "Not configured";
  const modelLabel = config.model || "—";

  const [open, setOpen] = useState(false);

  // Fetch the active provider's models when the popover opens (cloud only).
  useEffect(() => {
    if (open && activeProvider && !isLocalBaseUrl(activeProvider.baseUrl)) {
      ensureModels(activeProvider.baseUrl, activeProvider.apiKey);
    }
    // Re-resolve when the provider changes under an open popover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeProvider?.id]);

  const selectProvider = (id: string) => {
    if (target === "ai") selectSavedProvider(id);
    else selectAgentProvider(id);
  };
  const selectLocal = () => {
    if (target !== "ai") return;
    setAIConfig({ provider: "localllm", activeProviderId: undefined, baseUrl: undefined, apiKey: undefined });
  };
  const setModel = (model: string) => {
    if (target === "ai") setAIConfig({ model });
    else setAgentConfig({ model });
  };
  const refreshModels = () => {
    if (activeProvider) fetchModels(activeProvider.baseUrl, activeProvider.apiKey);
  };

  const triggerPad = size === "xs" ? "px-1.5 py-0.5 text-[0.643rem]" : "px-2 py-1 text-[0.714rem]";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Switch provider or model" side="top">
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Switch provider or model"
            className={cn(
              "flex items-center gap-1 rounded-md border border-[var(--border)] text-[var(--text-secondary)] transition-colors",
              "hover:bg-[var(--surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50",
              triggerPad,
              className,
            )}
          >
            <span className="max-w-[9rem] truncate">{providerLabel}</span>
            <span className="text-[var(--text-tertiary)] shrink-0">·</span>
            <span className="max-w-[9rem] truncate font-mono text-[var(--text-primary)]">{modelLabel}</span>
            <ChevronDown size={11} className="text-[var(--text-tertiary)] shrink-0" />
          </button>
        </Popover.Trigger>
      </Tooltip>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align={align}
          sideOffset={6}
          onInteractOutside={(e) => {
            // The model picker's dropdown is PORTALED outside this content —
            // clicking an option must not close the whole picker.
            const t = e.target as Element | null;
            if (t?.closest("[data-radix-popper-content-wrapper]")) e.preventDefault();
          }}
          className="z-50 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-3 space-y-3 animate-fade-in focus:outline-none"
        >
          <div className="text-[0.643rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {target === "ai" ? "Chat" : "Agent"} · provider &amp; model
          </div>

          {/* Provider list — every connected provider in the shared list */}
          <div className="space-y-1">
            <span className="text-[0.714rem] text-[var(--text-secondary)]">Provider</span>
            <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto pr-0.5">
              {target === "ai" && (
                <ProviderRow
                  label="On-device (Llama)"
                  active={isLocal}
                  onClick={selectLocal}
                />
              )}
              {savedProviders.map((p) => (
                <ProviderRow
                  key={p.id}
                  label={p.name || p.id}
                  active={!isLocal && p.id === config.activeProviderId}
                  onClick={() => selectProvider(p.id)}
                />
              ))}
              {savedProviders.length === 0 && !isLocal && (
                <p className="text-[0.643rem] text-[var(--text-tertiary)] px-1">
                  No providers yet — add one in Settings → AI &amp; Chat.
                </p>
              )}
            </div>
          </div>

          {/* Model — the active provider's models */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[0.714rem] text-[var(--text-secondary)]">Model</span>
              {activeProvider && !isLocal && (
                <button
                  type="button"
                  onClick={refreshModels}
                  disabled={modelsLoading}
                  className="flex items-center gap-1 text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={10} className={modelsLoading ? "animate-spin" : ""} />
                  Refresh
                </button>
              )}
            </div>
            {isLocal || !activeProvider ? (
              <p className="text-[0.643rem] text-[var(--text-tertiary)] px-1">
                {isLocal ? "Local on-device model." : "Select a provider above to load its models."}
              </p>
            ) : (
              <ModelPicker
                value={config.model ?? ""}
                options={availableModels}
                loading={modelsLoading}
                errored={testState === "error"}
                placeholder={isLocalBaseUrl(activeProvider.baseUrl) ? "local model" : "model id"}
                onChange={setModel}
                onRefresh={refreshModels}
              />
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProviderRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-left text-[0.714rem] transition-colors",
        active
          ? "text-[var(--accent)] bg-[var(--accent-dim)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
      )}
    >
      <span className="truncate flex-1">{label}</span>
      {active && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0" />}
    </button>
  );
}
