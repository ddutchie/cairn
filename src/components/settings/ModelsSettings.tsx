"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "./shared";
import { LocalServersCard } from "./AISettings";
import { BrowseProvidersModal } from "./tools/BrowseProvidersModal";

/**
 * Where providers come from. Both Chat and the coding agent pick their
 * active provider (and edit saved ones) on their own pages; this page is the
 * single place to add new ones, so the catalog and local-server detection
 * no longer appear twice.
 */
export function ModelsSettings() {
  const [browsing, setBrowsing] = useState(false);
  return (
    <div className="space-y-8">
      <SettingsGroup
        title="Add a provider"
        description="Saved providers are shared. Choose which one Chat uses on the Chat page, and which one the coding agent uses on the Coding agent page."
      >
        <SettingsRow
          label="Community providers"
          description="Ready-made OpenAI-compatible providers. Install one, then add your API key."
        >
          <Button variant="outline" size="sm" onClick={() => setBrowsing(true)}>
            <Download size={12} /> Browse community
          </Button>
        </SettingsRow>
        <LocalServersCard />
      </SettingsGroup>
      {browsing && <BrowseProvidersModal onClose={() => setBrowsing(false)} />}
    </div>
  );
}
