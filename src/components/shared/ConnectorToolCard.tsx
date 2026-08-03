"use client";

import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { ExternalRefChip } from "@/components/shared/cairn-ref-chip";
import { humanizeTool } from "@/lib/humanize-tool";

export interface ConnectorMeta {
  name: string;
  kind: "mcp" | "service";
  iconSvg?: string;
  brandColor?: string;
  label?: string;
}

export interface ConnectorToolCall {
  tool: string;
  args?: Record<string, unknown>;
  output?: string;
  externalRef?: { url: string; title?: string; snippet?: string };
}

export function ConnectorToolCard({ toolCall, connector, testId = "connector-message-card" }: {
  toolCall: ConnectorToolCall;
  connector: ConnectorMeta;
  testId?: string;
}) {
  const summary = humanizeTool(toolCall.tool, toolCall.args);
  return (
    <div data-testid={testId} className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden w-full max-w-xl">
      <div className="w-1 self-stretch shrink-0" style={{ background: connector.brandColor || "var(--accent)" }} />
      <div className="flex items-start gap-2 min-w-0 flex-1 px-2.5 py-2">
        <ConnectorLogo iconSvg={connector.iconSvg} kind={connector.kind} color={connector.brandColor} size={24} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[0.714rem] font-semibold text-[var(--text-primary)] truncate">{connector.label || connector.name}</span>
            <span className="text-[0.607rem] text-[var(--text-tertiary)]">via {connector.kind === "mcp" ? "MCP" : "HTTP service"}</span>
          </div>
          <p className="mt-0.5 text-[0.714rem] text-[var(--text-secondary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}</p>
          {toolCall.output && <p className="mt-1 text-[0.643rem] text-[var(--text-tertiary)] line-clamp-2">{toolCall.output}</p>}
          {toolCall.externalRef && <div className="mt-1"><ExternalRefChip toolName={toolCall.tool} externalRef={toolCall.externalRef} /></div>}
        </div>
      </div>
    </div>
  );
}
