"use client";

import { useState } from "react";
import { CheckCircle, ChevronDown, ChevronRight, Globe2, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { cn, prettifyToolLabel } from "@/lib/utils";
import { CairnRefChip, ExternalRefChip, extractCairnRef } from "@/components/shared/cairn-ref-chip";
import { ConnectorToolCard, type ConnectorMeta } from "@/components/shared/ConnectorToolCard";
import { WritingStylePromptChip, writingStyleNeedsSetup } from "@/components/shared/WritingStylePromptChip";
import { humanizeTool } from "@/lib/humanize-tool";
import { approvalPreview, approvalScopeLabel, riskForTool } from "@/lib/tool-risk";
import { registerBuiltinToolViews } from "@/lib/dsh-toolview";
import { toToolCallViewProps } from "@/lib/dsh-toolview/adapter";
import { KeyedSlotOutlet } from "@/lib/plugin-ui/SlotOutlet";
import { useSlotEntries } from "@/lib/plugin-ui/registry";
import type { ConversationToolCall } from "./conversation-message";

registerBuiltinToolViews();

interface ConversationToolCallProps {
  toolCall: ConversationToolCall;
  sessionId?: string;
  connectors?: Record<string, ConnectorMeta>;
}

function connectorForTool(name: string, connectors?: Record<string, ConnectorMeta>): ConnectorMeta | undefined {
  if (!connectors) return undefined;
  return Object.entries(connectors).find(([key]) => name.startsWith(key))?.[1];
}

function ApprovalCard({ toolCall, sessionId }: ConversationToolCallProps) {
  const risk = riskForTool(toolCall.name);
  const preview = approvalPreview(toolCall.name, toolCall.args);
  const scope = approvalScopeLabel(toolCall.name);
  const command = typeof toolCall.args?.command === "string" ? toolCall.args.command : undefined;
  if (!sessionId || !toolCall.callId) return <ToolCallBody toolCall={toolCall} />;
  const respond = (approved: boolean, grant?: "command" | "session") => {
    void window.electron?.piAgent.respondTool(sessionId, toolCall.callId!, approved, grant, grant === "command" ? command : undefined, toolCall.approvalNonce);
  };
  return (
    <div data-testid="approval-card" className="w-full max-w-xl rounded-lg border border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_6%,var(--surface))] px-3 py-2.5">
      <div className="flex items-start gap-2">
        {risk === "EXTERNAL" ? <Globe2 size={14} className="mt-0.5 text-[var(--warning)] shrink-0" /> : <ShieldAlert size={14} className="mt-0.5 text-[var(--warning)] shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-[0.786rem] font-medium text-[var(--text-primary)]">{humanizeTool(toolCall.name, toolCall.args).pre}</p>
          <p className="mt-0.5 text-[0.643rem] text-[var(--text-tertiary)]">This {scope}.</p>
        </div>
        <span className="text-[0.607rem] font-semibold tracking-wide text-[var(--warning)]">{risk}</span>
      </div>
      {preview && <pre data-testid="approval-preview" className="mt-2 max-h-24 overflow-hidden rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[0.643rem] leading-4 text-[var(--text-secondary)] whitespace-pre-wrap break-words">{preview}</pre>}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button data-testid="approval-deny" onClick={() => respond(false)} className="px-2 py-1 text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded">Deny</button>
        {command && <button data-testid="approval-allow-command" onClick={() => respond(true, "command")} className="px-2 py-1 text-[0.643rem] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded">Always allow command</button>}
        <button data-testid="approval-allow-once" onClick={() => respond(true)} className="px-2.5 py-1 text-[0.643rem] font-semibold text-white bg-[var(--accent)] hover:opacity-90 rounded">Allow once</button>
      </div>
    </div>
  );
}

function ToolCallBody({ toolCall }: { toolCall: ConversationToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = Boolean(toolCall.output);
  const summary = humanizeTool(toolCall.name, toolCall.args);
  return (
    <div>
      <button type="button" onClick={() => hasOutput && setExpanded((value) => !value)} className={cn("flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit text-left", hasOutput && "hover:border-[var(--accent)] cursor-pointer", !hasOutput && "cursor-default")}>
        {toolCall.ok ? <CheckCircle size={9} className="shrink-0 text-[var(--accent)]" /> : <XCircle size={9} className="shrink-0 text-[var(--danger)]" />}
        <span className="text-[0.714rem] text-[var(--text-secondary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}{!toolCall.ok && " failed"}</span>
        {hasOutput && (expanded ? <ChevronDown size={9} className="text-[var(--text-tertiary)]" /> : <ChevronRight size={9} className="text-[var(--text-tertiary)]" />)}
      </button>
      {expanded && <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[0.643rem] font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all">{toolCall.output}</pre>}
    </div>
  );
}

/** Render a tool from its durable/live state, independent of session kind. */
export function ConversationToolCall({ toolCall, sessionId, connectors }: ConversationToolCallProps) {
  const toolViewEntries = useSlotEntries("tool.call.toolview");
  if (toolViewEntries.some((entry) => entry.key === toolCall.name)) {
    return <KeyedSlotOutlet name="tool.call.toolview" matchKey={toolCall.name} props={toToolCallViewProps({ tool: toolCall.name, label: toolCall.label, args: JSON.stringify(toolCall.args ?? {}), output: toolCall.output, ok: toolCall.ok, callId: toolCall.callId } as never)} />;
  }
  if (toolCall.confirmRequired) return <ApprovalCard toolCall={toolCall} sessionId={sessionId} connectors={connectors} />;
  if (toolCall.running) return <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit"><Loader2 size={9} className="text-[var(--accent)] animate-spin" /><span className="text-[0.714rem] text-[var(--text-secondary)]">{prettifyToolLabel(toolCall.label)}</span></div>;
  if (toolCall.name === "get_user_writing_style" && writingStyleNeedsSetup(toolCall.output)) return <WritingStylePromptChip output={toolCall.output} />;
  const ref = toolCall.cairnRef ?? extractCairnRef(toolCall.name, toolCall.output);
  if (ref) return <CairnRefChip toolName={toolCall.name} cairnRef={ref} ok={toolCall.ok} />;
  const connector = connectorForTool(toolCall.name, connectors);
  if (connector) return <ConnectorToolCard toolCall={{ tool: toolCall.name, args: toolCall.args, output: toolCall.output, externalRef: toolCall.externalRef }} connector={connector} />;
  if (toolCall.externalRef) return <ExternalRefChip toolName={toolCall.name} externalRef={toolCall.externalRef} />;
  return <ToolCallBody toolCall={toolCall} />;
}
