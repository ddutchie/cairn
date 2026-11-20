"use client";

import { useState } from "react";
import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { ToolCard, ToolPayload } from "@/components/shared/ToolCard";
import { ExternalRefChip } from "@/components/shared/cairn-ref-chip";
import { humanizeConnectorTool } from "@/lib/humanize-tool";
import { prettyToolOutput, redactToolOutput, redactTranscriptValue } from "@/lib/redact-agent-transcript";
import { prettifyToolLabel } from "@/lib/utils";
import { extractExternalRefs, type ExternalRef } from "../../../shared/chat/external-ref";

const MAX_DETAIL_LENGTH = 8_000;

export interface ConnectorMeta {
  name: string;
  kind: "mcp" | "service";
  iconSvg?: string;
  brandColor?: string;
  label?: string;
}

export interface ConnectorToolCall {
  /** Call id: keeps the card open across transcript remounts. */
  callId?: string;
  tool: string;
  args?: Record<string, unknown>;
  output?: string;
  /** false renders the failed state; undefined/true renders success. */
  ok?: boolean;
  externalRef?: { url: string; title?: string; snippet?: string };
}

export function ConnectorToolCard({ toolCall, connector, testId = "connector-message-card" }: {
  toolCall: ConnectorToolCall;
  connector: ConnectorMeta;
  testId?: string;
}) {
  const summary = humanizeConnectorTool(toolCall.tool, toolCall.args, connector.label || connector.name);
  const output = prettyToolOutput(redactToolOutput(toolCall.output));
  const args = toolCall.args ? JSON.stringify(redactTranscriptValue(toolCall.args), null, 2).slice(0, MAX_DETAIL_LENGTH) : undefined;
  const toolLabel = prettifyToolLabel(toolCall.tool, { prettifyBare: true });
  const refs = collectExternalRefs(toolCall.externalRef, extractExternalRefs(output, 20));
  const transport = connector.kind === "mcp" ? "MCP" : "HTTP service";
  const ok = toolCall.ok !== false;
  return (
    <ToolCard
      testId={testId}
      summaryTestId="connector-tool-summary"
      persistKey={toolCall.callId}
      ok={ok}
      icon={<ConnectorLogo iconSvg={connector.iconSvg} kind={connector.kind} color={connector.brandColor} size={14} className="shrink-0" />}
      brand={connector.label || connector.name}
      summary={summary}
      tooltip={`${connector.label || connector.name} via ${transport}`}
      caption={`Tool: ${toolLabel} · via ${transport}`}
    >
      {args && <ToolPayload label="Arguments" value={args} />}
      {output && <ToolPayload label="Result" value={output} />}
      {refs.length > 0 && <ExternalRefs toolName={toolCall.tool} refs={refs} />}
    </ToolCard>
  );
}

function collectExternalRefs(primary: ExternalRef | undefined, extracted: ExternalRef[]): ExternalRef[] {
  const refs = primary ? [primary, ...extracted] : extracted;
  return refs.filter((ref, index) => refs.findIndex((candidate) => candidate.url === ref.url) === index);
}

function ExternalRefs({ toolName, refs }: { toolName: string; refs: ExternalRef[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? refs : refs.slice(0, 3);
  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      {visible.map((ref) => <ExternalRefChip key={ref.url} toolName={toolName} externalRef={ref} />)}
      {refs.length > 3 && (
        <button type="button" onClick={() => setShowAll((value) => !value)} className="px-1 text-2xs text-[var(--accent)] hover:underline">
          {showAll ? "Show less" : `Show ${refs.length - 3} more`}
        </button>
      )}
    </div>
  );
}

export { ToolPayload };
