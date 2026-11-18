"use client";

import { Mountain } from "lucide-react";
import { CairnRefChip, type CairnRef } from "@/components/shared/cairn-ref-chip";
import { ToolCard, ToolPanel, ToolPayload } from "@/components/shared/ToolCard";
import { cairnNameLookup } from "@/lib/cairn-name-lookup";
import { humanizeTool } from "@/lib/humanize-tool";
import type { ConversationToolCall } from "@/lib/conversation/message";
import { prettyToolOutput, redactToolOutput, redactTranscriptValue } from "@/lib/redact-agent-transcript";
import { riskForTool } from "@/lib/tool-risk";
import { prettifyToolLabel } from "@/lib/utils";
import { cairnToolView } from "./cairn-tool-views";

const MAX_DETAIL_LENGTH = 8_000;

/**
 * A settled Cairn data-tool call, rendered like a connector call: identity mark,
 * "Cairn · action" header, and labelled Arguments / Result panels. A note or task
 * the call touched stays reachable as a chip inside the card.
 */
export function CairnToolCard({ toolCall, cairnRef }: { toolCall: ConversationToolCall; cairnRef?: CairnRef }) {
  // The structured result, when there is one: a failed call can still carry the part that applied
  // (the engine puts a failed call's whole result text in `error`).
  const resultText = toolCall.output ?? toolCall.error;
  const parsed = parseObject(resultText);
  const base = toolCall.viewTitle ? { pre: toolCall.viewTitle } : humanizeTool(toolCall.name, toolCall.args, cairnNameLookup);
  // A style rule that was already in the guide must not read as "Added".
  const summary = toolCall.name === "update_user_writing_style" && toolCall.ok && parsed?.updated === false
    ? { pre: "Writing style already had this", obj: typeof toolCall.args?.section === "string" ? toolCall.args.section : undefined }
    : base;
  const args = toolCall.args && Object.keys(toolCall.args).length > 0
    ? JSON.stringify(redactTranscriptValue(toolCall.args), null, 2).slice(0, MAX_DETAIL_LENGTH)
    : undefined;
  const output = prettyToolOutput(redactToolOutput(resultText));
  const view = cairnToolView(toolCall);
  const errorMessage = toolCall.ok ? undefined : typeof parsed?.error === "string" ? parsed.error : parsed ? undefined : toolCall.error;
  // Successful writes open on their own (specialised view or generic panels); reads and failures stay collapsed.
  const isWrite = toolCall.ok && riskForTool(toolCall.name) !== "READ";
  const raw = (args || output) && (
    <>
      {args && <ToolPayload label="Arguments" value={args} />}
      {output && <ToolPayload label="Result" value={output} />}
    </>
  );
  return (
    <ToolCard
      testId="cairn-tool-card"
      summaryTestId="cairn-tool-summary"
      ok={toolCall.ok}
      icon={<Mountain size={13} className="shrink-0 text-[var(--accent)]" />}
      brand="Cairn"
      summary={summary}
      tooltip="Cairn workspace tool"
      defaultExpanded={isWrite}
      caption={`Tool: ${prettifyToolLabel(toolCall.name)}`}
    >
      {cairnRef && <div className="mt-1"><CairnRefChip toolName={toolCall.name} cairnRef={cairnRef} ok={toolCall.ok} /></div>}
      {errorMessage && <ToolPanel label="Error" className="border-[color-mix(in_srgb,var(--danger)_35%,var(--border))]"><p className="whitespace-pre-wrap break-words text-2xs text-[var(--text-secondary)]">{errorMessage}</p></ToolPanel>}
      {view ? (
        <>
          {view}
          {raw && (
            <details className="mt-1 group">
              <summary className="cursor-pointer select-none text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">Raw call</summary>
              {raw}
            </details>
          )}
        </>
      ) : raw}
    </ToolCard>
  );
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
