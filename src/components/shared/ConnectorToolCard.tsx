"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { ExternalRefChip } from "@/components/shared/cairn-ref-chip";
import { humanizeTool } from "@/lib/humanize-tool";
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
  const [expanded, setExpanded] = useState(false);
  const summary = humanizeTool(toolCall.tool, toolCall.args);
  const output = prettyToolOutput(redactToolOutput(toolCall.output));
  const args = toolCall.args ? JSON.stringify(redactTranscriptValue(toolCall.args), null, 2).slice(0, MAX_DETAIL_LENGTH) : undefined;
  const toolLabel = prettifyToolLabel(toolCall.tool, { prettifyBare: true });
  const refs = collectExternalRefs(toolCall.externalRef, extractExternalRefs(output, 20));
  return (
    <div data-testid={testId} className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden w-full max-w-xl">
      <div className="w-1 self-stretch shrink-0" style={{ background: connector.brandColor || "var(--accent)" }} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-[var(--surface-2)] transition-colors"
        >
          <ConnectorLogo iconSvg={connector.iconSvg} kind={connector.kind} color={connector.brandColor} size={24} />
          <span className="min-w-0 flex-1 truncate text-[0.714rem] font-semibold text-[var(--text-primary)]">{connector.label || connector.name}</span>
          <span className="text-[0.607rem] text-[var(--text-tertiary)]">via {connector.kind === "mcp" ? "MCP" : "HTTP service"}</span>
          {expanded ? <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" />}
        </button>
        {expanded && (
          <div className="border-t border-[var(--border)] px-2.5 pb-2 pt-1.5">
            <p className="text-[0.714rem] text-[var(--text-secondary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}</p>
            <p className="mt-1 text-[0.643rem] text-[var(--text-tertiary)]">Tool: {toolLabel}</p>
            {args && <ToolPayload label="Arguments" value={args} />}
            {output && <ToolPayload label="Result" value={output} />}
            {refs.length > 0 && <ExternalRefs toolName={toolCall.tool} refs={refs} />}
          </div>
        )}
      </div>
    </div>
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
        <button type="button" onClick={() => setShowAll((value) => !value)} className="px-1 text-[0.643rem] text-[var(--accent)] hover:underline">
          {showAll ? "Show less" : `Show ${refs.length - 3} more`}
        </button>
      )}
    </div>
  );
}

function ToolPayload({ label, value }: { label: string; value: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  return (
    <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
      <p className="mb-1 text-[0.607rem] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">{label}</p>
      {parsed !== undefined ? <JsonTree value={parsed} /> : <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[0.643rem] leading-5 text-[var(--text-tertiary)]">{value}</pre>}
    </div>
  );
}

function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="text-[var(--text-tertiary)]">null</span>;
  if (typeof value !== "object") return <span className="break-words text-[var(--text-secondary)]">{typeof value === "string" ? `"${value}"` : String(value)}</span>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  return (
    <div className="space-y-0.5 font-mono text-[0.643rem]">
      {entries.map(([key, child]) => {
        const nested = child !== null && typeof child === "object";
        return nested ? (
          <details key={key} open={depth < 1} className="border-l border-[var(--border)] pl-2">
            <summary className="cursor-pointer text-[var(--text-secondary)]">{key} <span className="text-[var(--text-tertiary)]">{Array.isArray(child) ? `[${child.length}]` : "{…}"}</span></summary>
            <JsonTree value={child} depth={depth + 1} />
          </details>
        ) : (
          <div key={key} className="grid grid-cols-[minmax(5rem,35%)_1fr] gap-2 border-l border-[var(--border)] pl-2">
            <span className="break-words text-[var(--text-tertiary)]">{key}</span>
            <JsonTree value={child} depth={depth + 1} />
          </div>
        );
      })}
    </div>
  );
}
