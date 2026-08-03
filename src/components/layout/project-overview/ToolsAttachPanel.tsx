"use client";

import { useEffect, useMemo } from "react";
import { Wrench } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import type { ToolType } from "@/types";
import { SectionHeader } from "./primitives";
import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { useCommunityConnectorMap, type ChatConnectorMeta } from "@/components/chat/chat-panel/connector-context";

/**
 * Per-project tool attach panel (Project Overview).
 *
 * Lists every ENABLED workspace tool (MCP servers + custom services) and lets
 * the user toggle whether each is active for this project. Only workspace-
 * enabled tools appear — a tool disabled in Settings is never attachable.
 */
export function ToolsAttachPanel({
  projectId,
  workspaceId,
  onManage,
}: {
  projectId: string;
  workspaceId: string;
  onManage: () => void;
}) {
  const {
    mcpServers,
    customServices,
    toolAttachments,
    fetchTools,
    fetchToolAttachments,
    setToolAttachment,
    clearToolAttachment,
  } = useCairnStore(
    useShallow((s) => ({
      mcpServers: s.mcpServers,
      customServices: s.customServices,
      toolAttachments: s.toolAttachments,
      fetchTools: s.fetchTools,
      fetchToolAttachments: s.fetchToolAttachments,
      setToolAttachment: s.setToolAttachment,
      clearToolAttachment: s.clearToolAttachment,
    }))
  );

  useEffect(() => {
    if (workspaceId) fetchTools(workspaceId);
  }, [workspaceId, fetchTools]);

  useEffect(() => {
    if (projectId) fetchToolAttachments(projectId);
  }, [projectId, fetchToolAttachments]);

  const enabledMcp = useMemo(() => mcpServers.filter((s) => s.enabled), [mcpServers]);
  const enabledSvc = useMemo(() => customServices.filter((s) => s.enabled), [customServices]);
  const connectorMap = useCommunityConnectorMap();

  const isAttached = (toolType: ToolType, toolId: string) =>
    toolAttachments.some((a) => a.projectId === projectId && a.toolType === toolType && a.toolId === toolId && a.enabled);

  const toggle = (toolType: ToolType, toolId: string, on: boolean) => {
    if (on) setToolAttachment(projectId, toolType, toolId, true);
    else clearToolAttachment(projectId, toolType, toolId);
  };

  const total = enabledMcp.length + enabledSvc.length;

  return (
    <section>
      <SectionHeader title="Tools" icon={<Wrench size={12} />} action={{ label: "Manage", onClick: onManage }} />
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2">
        {total === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)] py-4 text-center">
            No enabled tools. Add and enable MCP servers or services in Settings → Tools, then attach them here.
          </p>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {enabledMcp.map((s) => (
              <AttachRow
                key={s.id}
                kind="mcp"
                connector={connectorMap[`mcp__${s.id}__`]}
                name={s.name}
                subtitle={s.baseUrl}
                attached={isAttached("mcp", s.id)}
                onToggle={(on) => toggle("mcp", s.id, on)}
              />
            ))}
            {enabledSvc.map((s) => (
              <AttachRow
                key={s.id}
                kind="service"
                connector={connectorMap[`svc__${s.id}__`]}
                name={s.name}
                subtitle={`${s.method} ${s.apiUrl}`}
                attached={isAttached("service", s.id)}
                onToggle={(on) => toggle("service", s.id, on)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AttachRow({
  kind,
  connector,
  name,
  subtitle,
  attached,
  onToggle,
}: {
  kind: "mcp" | "service";
  connector?: ChatConnectorMeta;
  name: string;
  subtitle: string;
  attached: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-2 py-2.5">
      <ConnectorLogo
        iconSvg={connector?.iconSvg}
        kind={kind}
        color={connector?.brandColor}
        size={24}
        className="flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="text-[0.786rem] text-[var(--text-primary)] truncate">{name}</div>
        <div className="text-[0.714rem] text-[var(--text-tertiary)] truncate font-mono">{subtitle}</div>
      </div>
      <button
        onClick={() => onToggle(!attached)}
        role="switch"
        aria-checked={attached}
        aria-label={`Attach ${name} to this project`}
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0",
          attached ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface)] shadow-sm transition-transform",
            attached ? "translate-x-4.5" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
