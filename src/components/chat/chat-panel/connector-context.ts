"use client";

import { useEffect, useMemo, useState } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { RegistryFetchResult } from "@/types";
import type { ConnectorMeta } from "@/components/shared/ConnectorToolCard";

export type ChatConnectorMeta = ConnectorMeta;


export function parseToolArgs(args?: string): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Resolve installed MCP/service IDs to the current cairn-community branding. */
export function useCommunityConnectorMap(): Record<string, ChatConnectorMeta> {
  const { activeWorkspaceId, mcpServers, customServices } = useCairnStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    mcpServers: s.mcpServers,
    customServices: s.customServices,
  })));
  const [manifest, setManifest] = useState<RegistryFetchResult["manifest"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchRegistry = window.electron?.registry.fetch;
    if (!fetchRegistry) return () => { cancelled = true; };
    fetchRegistry().then((result) => {
      if (!cancelled) setManifest(result.manifest);
    }).catch(() => { /* cards use generic fallback when offline */ });
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);

  return useMemo(() => {
    const map: Record<string, ChatConnectorMeta> = {};
    if (!manifest) return map;
    for (const server of mcpServers) {
      const entry = manifest.mcpServers.find((candidate) => candidate.id === server.communityId || candidate.definition.name === server.name);
      if (entry) map[`mcp__${server.id}__`] = { name: server.name, label: entry.definition.name, kind: "mcp", iconSvg: entry.iconSvg, brandColor: entry.brandColor };
    }
    for (const service of customServices) {
      const entry = manifest.services.find((candidate) => candidate.id === service.communityId || candidate.definition.name === service.name);
      if (entry) map[`svc__${service.id}__`] = { name: service.name, label: entry.definition.name, kind: "service", iconSvg: entry.iconSvg, brandColor: entry.brandColor };
    }
    return map;
  }, [manifest, mcpServers, customServices]);
}

export function connectorForTool(toolName: string, map: Record<string, ChatConnectorMeta>): ChatConnectorMeta | undefined {
  return Object.entries(map).find(([prefix]) => toolName.startsWith(prefix))?.[1];
}
