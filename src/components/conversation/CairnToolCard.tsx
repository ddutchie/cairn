"use client";

import { Mountain, User } from "lucide-react";
import { useCairnStore } from "@/store";
import { IconButton } from "@/components/ui/icon-button";
import { CairnRefChip, CairnRefOpenButton, type CairnRef } from "@/components/shared/cairn-ref-chip";
import { ToolCard, ToolPanel, ToolPayload } from "@/components/shared/ToolCard";
import { cairnNameLookup } from "@/lib/cairn-name-lookup";
import { humanizeSearchResult, humanizeTool } from "@/lib/humanize-tool";
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
  // The structured result, when there is one: a failed call can still carry the part that applied
  // (the engine puts a failed call's whole result text in `error`).
  const resultText = toolCall.output ?? toolCall.error;
  const parsed = parseObject(resultText);
  // A people call names its person by an opaque id: read the name from the result when the call didn't carry one.
  const summaryArgs = toolCall.name === "people" ? withOutcome(withPersonName(toolCall.args, parsed), parsed) : toolCall.args;
  const base = toolCall.viewTitle ? { pre: toolCall.viewTitle } : humanizeTool(toolCall.name, summaryArgs, cairnNameLookup);
  // A style rule that was already in the guide must not read as "Added".
  const hitCount = toolCall.ok && (toolCall.name === "search_notes" || toolCall.name === "search_tasks") ? resultCount(resultText) : undefined;
  const summary = toolCall.name === "update_user_writing_style" && toolCall.ok && parsed?.updated === false
    ? { pre: "Writing style already had this", obj: typeof toolCall.args?.section === "string" ? toolCall.args.section : undefined }
    : hitCount !== undefined
      ? humanizeSearchResult(toolCall.name === "search_notes" ? "notes" : "tasks", toolCall.args ?? {}, hitCount)
      : base;
  const args = toolCall.args && Object.keys(toolCall.args).length > 0
    ? JSON.stringify(redactTranscriptValue(toolCall.args), null, 2).slice(0, MAX_DETAIL_LENGTH)
    : undefined;
  const output = prettyToolOutput(redactToolOutput(resultText));
  const view = cairnToolView(toolCall);
  const personId = toolCall.name === "people" && toolCall.ok ? personIdOf(parsed) : undefined;
  const errorMessage = toolCall.ok ? undefined : typeof parsed?.error === "string" ? parsed.error : parsed ? undefined : toolCall.error;
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
      headerAction={cairnRef && toolCall.ok ? <CairnRefOpenButton cairnRef={cairnRef} /> : personId ? <OpenPersonButton personId={personId} /> : undefined}
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

/** The call's arguments with `name` filled in from the result (person, edge source or attendee) when the call only had an id. */
function withPersonName(args: Record<string, unknown> | undefined, parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args || (typeof args.name === "string" && args.name.trim()) || !parsed) return args;
  const at = (k: string) => (parsed[k] && typeof parsed[k] === "object" ? parsed[k] as Record<string, unknown> : undefined);
  const name = [parsed.name, at("person")?.name, at("attendee")?.name, at("mention")?.name, at("edge")?.source].find((v) => typeof v === "string" && v.trim());
  return name ? { ...args, name } : args;
}

/** What the call did, read from its result, for summaries that depend on it (created or updated; attendee kept). */
function withOutcome(args: Record<string, unknown> | undefined, parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args || !parsed) return args;
  if (args.action === "upsert" && typeof parsed.created === "boolean") return { ...args, outcome: parsed.created ? "created" : "updated" };
  if (args.action === "link" && args.link === "attendee" && args.remove === true && parsed.removed === false) return { ...args, outcome: "kept" };
  return args;
}

/** The one person a `people` result is about (get, upsert, timeline, a person's relationships), if any. */
function personIdOf(parsed: Record<string, unknown> | undefined): string | undefined {
  if (!parsed) return undefined;
  const nested = parsed.person && typeof parsed.person === "object" ? (parsed.person as Record<string, unknown>).id : undefined;
  const id = typeof nested === "string" ? nested : typeof parsed.id === "string" && typeof parsed.name === "string" ? parsed.id : undefined;
  return id || undefined;
}

function OpenPersonButton({ personId }: { personId: string }) {
  const openPerson = useCairnStore((s) => s.openPerson);
  return (
    <IconButton size="sm" variant="outline" label="Open person" tooltip="Open this person" tooltipSide="top" onClick={() => openPerson(personId)} data-testid="people-open">
      <User size={11} />
    </IconButton>
  );
}

/** Number of hits in a search result (a top-level array, or `{results}`), or undefined when it isn't one. */
function resultCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object" && Array.isArray((value as { results?: unknown }).results)) return (value as { results: unknown[] }).results.length;
  } catch { /* not JSON */ }
  return undefined;
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
