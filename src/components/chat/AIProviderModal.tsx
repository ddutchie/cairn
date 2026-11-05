"use client";

import { useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { BrowseProvidersModal } from "@/components/settings/tools/BrowseProvidersModal";
import { ProviderForm, saveNewProvider } from "@/components/settings/ProviderManager";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { RegistryProviderEntry } from "@/types";

const DEFAULT_MODEL = "gpt-5.6-luna";

interface Props {
  /** The surface the new provider becomes active for. */
  kind?: "ai" | "agent";
  onClose: () => void;
}

/**
 * Quick way to add an AI provider from the chat. It uses the same form as
 * Settings → AI (name, endpoint, model picker with refresh, keychain key), and
 * the same community catalog as Browse Providers. The new provider becomes the
 * active one for that surface.
 */
export function AIProviderModal({ kind = "ai", onClose }: Props) {
  const { addSavedProvider, updateSavedProvider, deleteSavedProvider, selectSavedProvider, selectAgentProvider } = useCairnStore(
    useShallow((s) => ({
      addSavedProvider: s.addSavedProvider,
      updateSavedProvider: s.updateSavedProvider,
      deleteSavedProvider: s.deleteSavedProvider,
      selectSavedProvider: s.selectSavedProvider,
      selectAgentProvider: s.selectAgentProvider,
    })),
  );
  const [browseOpen, setBrowseOpen] = useState(false);

  /** A community provider was installed: make it this surface's active provider. */
  function handleInstalled(entry: RegistryProviderEntry) {
    const row = useCairnStore.getState().aiConfig.savedProviders?.find((p) => p.communityId === entry.id);
    if (row) (kind === "agent" ? selectAgentProvider : selectSavedProvider)(row.id);
    setBrowseOpen(false);
    onClose();
  }

  return (
    <>
      <ModalShell
        open
        onClose={onClose}
        size="md"
        title="Add an AI provider"
        description="Chat needs a provider. Pick a community one or enter your own."
      >
        <div className="flex flex-col gap-3 px-6 pt-4 pb-2">
          <button
            type="button"
            onClick={() => setBrowseOpen(true)}
            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-left hover:border-[color-mix(in_srgb,var(--accent)_40%,transparent)] transition-colors"
          >
            <span className="flex flex-col">
              <span className="text-sm text-[var(--text-primary)]">Browse community providers</span>
              <span className="text-xs text-[var(--text-tertiary)]">One click, then paste your key</span>
            </span>
            <span className="text-xs text-[var(--accent)]">Browse</span>
          </button>

          <ProviderForm
            defaultModel={DEFAULT_MODEL}
            onCancel={onClose}
            onSave={async (data) => {
              await saveNewProvider(data, kind, { addSavedProvider, updateSavedProvider, deleteSavedProvider });
              onClose();
            }}
          />
        </div>
      </ModalShell>

      {browseOpen && (
        <BrowseProvidersModal onClose={() => setBrowseOpen(false)} onInstalled={handleInstalled} />
      )}
    </>
  );
}
