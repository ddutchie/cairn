"use client";

import { Mountain } from "lucide-react";
import { CairnRefChip, type CairnRef } from "@/components/shared/cairn-ref-chip";
import { ToolCard, ToolPayload } from "@/components/shared/ToolCard";
import { cairnNameLookup } from "@/lib/cairn-name-lookup";
import { humanizeTool } from "@/lib/humanize-tool";
import type { ConversationToolCall } from "@/lib/conversation/message";
import { prettyToolOutput, redactToolOutput, redactTranscriptValue } from "@/lib/redact-agent-transcript";
import { prettifyToolLabel } from "@/lib/utils";
import { cairnToolView } from "./cairn-tool-views";

const MAX_DETAIL_LENGTH = 8_000;

/**
 * A settled Cairn data-tool call, rendered like a connector call: identity mark,
 * "Cairn · action" header, and labelled Arguments / Result panels. A note or task
 * the call touched stays reachable as a chip inside the card.
 */
export function CairnToolCard({ toolCall, cairnRef }: { toolCall: ConversationToolCall; cairnRef?: CairnRef }) {
  const summary = toolCall.viewTitle ? { pre: toolCall.viewTitle } : humanizeTool(toolCall.name, toolCall.args, cairnNameLookup);
  const args = toolCall.args && Object.keys(toolCall.args).length > 0
    ? JSON.stringify(redactTranscriptValue(toolCall.args), null, 2).slice(0, MAX_DETAIL_LENGTH)
    : undefined;
  const output = prettyToolOutput(redactToolOutput(toolCall.ok ? toolCall.output : toolCall.error ?? toolCall.output));
  const view = cairnToolView(toolCall);
  return (
    <ToolCard
      testId="cairn-tool-card"
      summaryTestId="cairn-tool-summary"
      ok={toolCall.ok}
      icon={<Mountain size={13} className="shrink-0 text-[var(--accent)]" />}
      brand="Cairn"
      summary={summary}
      tooltip="Cairn workspace tool"
      defaultExpanded={Boolean(view) && !toolCall.name.startsWith("search_")}
      caption={`Tool: ${prettifyToolLabel(toolCall.name)}`}
    >
      {cairnRef && <div className="mt-1"><CairnRefChip toolName={toolCall.name} cairnRef={cairnRef} ok={toolCall.ok} /></div>}
      {view ? (
        <>
          {view}
          {(args || output) && (
            <details className="mt-1 group">
              <summary className="cursor-pointer select-none text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">Raw call</summary>
              {args && <ToolPayload label="Arguments" value={args} />}
              {output && <ToolPayload label="Result" value={output} />}
            </details>
          )}
        </>
      ) : (
        <>
          {args && <ToolPayload label="Arguments" value={args} />}
          {output && <ToolPayload label="Result" value={output} />}
        </>
      )}
    </ToolCard>
  );
}
