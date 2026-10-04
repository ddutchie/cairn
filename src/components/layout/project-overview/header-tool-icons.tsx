"use client";

import { useEffect } from "react";
import { Wrench } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { useCommunityConnectorMap } from "@/components/chat/chat-panel/connector-context";
import { Tooltip } from "@/components/ui/tooltip";
import type { ToolType } from "@/types";

export function HeaderToolIcons({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const { mcpServers, customServices, toolAttachments, fetchTools, fetchToolAttachments, setToolAttachment, clearToolAttachment } =
    useCairnStore(
      useShallow((s) => ({
        mcpServers: s.mcpServers,
        customServices: s.customServices,
        toolAttachments: s.toolAttachments,
        fetchTools: s.fetchTools,
        fetchToolAttachments: s.fetchToolAttachments,
        setToolAttachment: s.setToolAttachment,
        clearToolAttachment: s.clearToolAttachment,
      })),
    );
  const connectorMap = useCommunityConnectorMap();

  useEffect(() => {
    if (workspaceId) void fetchTools(workspaceId);
  }, [workspaceId, fetchTools]);
  useEffect(() => {
    if (projectId) void fetchToolAttachments(projectId);
  }, [projectId, fetchToolAttachments]);

  const enabledMcp = mcpServers.filter((s) => s.enabled);
  const enabledSvc = customServices.filter((s) => s.enabled);
  const total = enabledMcp.length + enabledSvc.length;
  if (total === 0) return null;

  const isAttached = (toolType: ToolType, toolId: string) =>
    toolAttachments.some((a) => a.projectId === projectId && a.toolType === toolType && a.toolId === toolId && a.enabled);
  const toggle = (toolType: ToolType, toolId: string, on: boolean) => {
    if (on) setToolAttachment(projectId, toolType, toolId, true);
    else clearToolAttachment(projectId, toolType, toolId);
  };

  const items: Array<{ key: string; name: string; kind: "mcp" | "service"; id: string; connectorKey: string }> = [
    ...enabledMcp.map((s) => ({ key: `mcp-${s.id}`, name: s.name, kind: "mcp" as const, id: s.id, connectorKey: `mcp__${s.id}__` })),
    ...enabledSvc.map((s) => ({ key: `svc-${s.id}`, name: s.name, kind: "service" as const, id: s.id, connectorKey: `svc__${s.id}__` })),
  ];

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className="inline-flex items-center gap-1 text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">
        <Wrench size={10} /> Tools
      </span>
      <span className="flex items-center gap-1">
        {items.slice(0, 6).map((it) => {
          const attached = isAttached(it.kind, it.id);
          const meta = connectorMap[it.connectorKey];
          return (
            <Tooltip key={it.key} content={it.name}>
              <button
                type="button"
                onClick={() => toggle(it.kind, it.id, !attached)}
                aria-pressed={attached}
                className={cn(
                  "w-7 h-7 rounded-full grid place-items-center border transition-all",
                  attached
                    ? "bg-[var(--accent-dim)] border-[var(--accent)] shadow-sm ring-1 ring-[var(--accent)]/30"
                    : "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--muted)] hover:bg-[var(--surface-2)]",
                )}
              >
                <ConnectorLogo iconSvg={meta?.iconSvg} kind={it.kind} color={meta?.brandColor} size={16} />
              </button>
            </Tooltip>
          );
        })}
        {items.length > 6 && <span className="text-xs text-[var(--text-tertiary)]">+{items.length - 6}</span>}
      </span>
    </span>
  );
}
