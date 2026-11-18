"use client";

import { useEffect, useMemo, useState } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { RegistryFetchResult } from "@/types";
import { registryClient } from "@/lib/ipc/registry";
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
    const fetchRegistry = registryClient.fetch;
    if (!fetchRegistry) return () => { cancelled = true; };
    fetchRegistry().then((result) => {
      if (!cancelled) setManifest(result.manifest);
    }).catch(() => { /* cards use generic fallback when offline */ });
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);

  return useMemo(() => {
    const map: Record<string, ChatConnectorMeta> = {};
    // Every configured server gets a connector card; a community-registry match only adds branding,
    // so locally configured servers (e.g. a stdio MCP) and an unreachable registry still render as cards.
    for (const server of mcpServers) {
      const entry = manifest?.mcpServers.find((candidate) => candidate.id === server.communityId || candidate.definition.name === server.communityId || candidate.definition.name === server.name);
      map[`mcp__${server.id}__`] = { name: server.name, label: entry?.definition.name, kind: "mcp", iconSvg: entry?.iconSvg, brandColor: entry?.brandColor };
    }
    for (const service of customServices) {
      const entry = manifest?.services.find((candidate) => candidate.id === service.communityId || candidate.definition.name === service.communityId || candidate.definition.name === service.name);
      map[`svc__${service.id}__`] = { name: service.name, label: entry?.definition.name, kind: "service", iconSvg: entry?.iconSvg, brandColor: entry?.brandColor };
    }
    return map;
  }, [manifest, mcpServers, customServices]);
}

export function connectorForTool(toolName: string, map: Record<string, ChatConnectorMeta>): ChatConnectorMeta | undefined {
  return Object.entries(map).find(([prefix]) => toolName.startsWith(prefix))?.[1];
}
