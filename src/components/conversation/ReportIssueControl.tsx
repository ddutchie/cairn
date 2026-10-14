"use client";

import { useEffect, useState } from "react";
import { Flag } from "lucide-react";
import { useCairnStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { ModalShell } from "@/components/ui/modal-shell";
import { Toggle } from "@/components/ui/toggle";
import type { ConversationMessage } from "@/lib/conversation/message";
import { buildIssueUrl, ISSUE_REPO, ISSUE_TITLE_MAX, type IssueEnv, type IssueSetup } from "../../../shared/chat/issue-report";

function platformName(): string {
  if (typeof navigator === "undefined") return "unknown";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || navigator.platform || "unknown";
}

/**
 * "Report an issue" for one assistant reply. Opens a prefilled GitHub issue in
 * the browser, so the user reviews and submits it themselves: Cairn holds no
 * GitHub token and posts nothing. The reply is opt-in because it may be private.
 */
export function ReportIssueControl({ message }: { message: ConversationMessage }) {
  const reply = message.content;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [includeReply, setIncludeReply] = useState(false);
  const [includeSetup, setIncludeSetup] = useState(false);
  const [setupTools, setSetupTools] = useState<IssueSetup["tools"]>();
  const [setupSkills, setSetupSkills] = useState<string[]>([]);

  const onAgent = useCairnStore((s) => s.activeView === "agent");
  const aiConfig = useCairnStore((s) => s.aiConfig);
  const agentConfig = useCairnStore((s) => s.agentConfig);
  const cfg = onAgent ? agentConfig : aiConfig;
  const mcpServers = useCairnStore((s) => s.mcpServers);
  const mcpTools = useCairnStore((s) => s.mcpTools);

  // Tool inventory and skills live in the main process; fetch them only once
  // the user opts in, so nothing is gathered for a report that won't include it.
  useEffect(() => {
    if (!open || !includeSetup) return;
    let cancelled = false;
    void (async () => {
      try {
        const inv = await window.electron?.runtime?.toolsInventory?.();
        const list = inv?.surfaces?.[onAgent ? "coding" : "chat"] ?? [];
        const bySource: Record<string, number> = {};
        for (const t of list) bySource[t.source] = (bySource[t.source] ?? 0) + 1;
        if (!cancelled && inv?.surfaces) setSetupTools({ total: list.length, bySource });
      } catch { /* optional detail */ }
      try {
        const cwd = await window.electron?.getWorkspacePath();
        const prompt = cwd ? await window.electron?.runtime?.systemPromptPreview({ cwd }) : undefined;
        if (!cancelled && prompt) setSetupSkills((prompt.skills ?? []).map((k) => k.name));
      } catch { /* optional detail */ }
    })();
    return () => { cancelled = true; };
  }, [open, includeSetup, onAgent]);

  const toolCalls = message.toolCalls ?? [];
  const failed = toolCalls.filter((t) => !t.running && !t.ok);
  const stats = message.stats;
  const effort = cfg.reasoningEffort && cfg.reasoningEffort !== "auto" ? cfg.reasoningEffort : undefined;

  const env: IssueEnv = {
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
    platform: platformName(),
    surface: onAgent ? "Coding agent" : "Chat",
    model: cfg.model || undefined,
    contextWindow: cfg.contextLimit,
    maxOutput: cfg.maxOutputAuto === false ? cfg.maxOutputTokens : "Auto",
    reasoningEffort: effort,
    approvalMode: onAgent ? (agentConfig.mode ?? (agentConfig.autoApprove ? "auto" : "interactive")) : undefined,
    subagents: onAgent ? undefined : aiConfig.subagentsEnabled,
    turn: stats ? { ttftMs: stats.ttftMs, tokensPerSecond: stats.tokensPerSecond, outputTokens: stats.outputTokens } : undefined,
    setup: includeSetup
      ? {
          mcpServers: mcpServers.map((m) => ({
            name: m.name,
            enabled: m.enabled,
            tools: mcpTools[m.id] ? mcpTools[m.id].tools.length - (m.disabledTools?.length ?? 0) : undefined,
          })),
          tools: setupTools,
          skills: setupSkills,
        }
      : undefined,
    toolCalls: toolCalls.length
      ? { total: toolCalls.length, failed: failed.length, failedNames: [...new Set(failed.map((t) => t.name))].slice(0, 5) }
      : undefined,
  };

  const submit = () => {
    const { url } = buildIssueUrl({ title, notes, reply: includeReply ? reply : undefined, env });
    if (window.electron?.openExternal) window.electron.openExternal(url);
    else window.open(url, "_blank", "noopener");
    setOpen(false);
  };

  return (
    <>
      <Tooltip content="Report an issue">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Report an issue with this reply"
          className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
        >
          <Flag size={10} />
        </button>
      </Tooltip>
      <ModalShell
        open={open}
        onClose={() => setOpen(false)}
        title="Report an issue"
        subtitle={`Opens a prefilled issue on github.com/${ISSUE_REPO}. You review it before submitting.`}
        description="Describe what went wrong. Nothing is sent until you submit the issue on GitHub."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={submit}>Open on GitHub</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            maxLength={ISSUE_TITLE_MAX}
            aria-label="Issue title"
          />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What went wrong?"
            aria-label="What went wrong"
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
          />
          <label className="flex items-center justify-between gap-3 text-[0.786rem] text-[var(--text-secondary)]">
            <span>
              Include this reply
              <span className="block text-[0.714rem] text-[var(--text-tertiary)]">
                {reply.length.toLocaleString("en-US")} characters; long replies are trimmed to fit.
              </span>
            </span>
            <Toggle checked={includeReply} onCheckedChange={setIncludeReply} label="Include this reply" />
          </label>
          <label className="flex items-center justify-between gap-3 text-[0.786rem] text-[var(--text-secondary)]">
            <span>
              Include connected MCP servers, tools and skills
              <span className="block text-[0.714rem] text-[var(--text-tertiary)]">
                Names only ({mcpServers.length} MCP server{mcpServers.length === 1 ? "" : "s"}); never URLs, keys or arguments.
              </span>
            </span>
            <Toggle checked={includeSetup} onCheckedChange={setIncludeSetup} label="Include connected MCP servers, tools and skills" />
          </label>
          <div className="rounded-md border border-[var(--border-subtle)] px-3 py-2 text-[0.714rem] text-[var(--text-tertiary)]">
            Always included: Cairn v{env.appVersion}, {env.platform}, {env.surface}
            {env.model ? `, model ${env.model}` : ""}
            {env.contextWindow ? `, ${env.contextWindow.toLocaleString("en-US")} token context` : ""}
            {`, max output ${typeof env.maxOutput === "number" ? env.maxOutput.toLocaleString("en-US") : env.maxOutput}`}
            {effort ? `, reasoning ${effort}` : ""}
            {env.turn ? ", this turn's speed stats" : ""}
            {env.toolCalls ? `, tool call results (${env.toolCalls.total} total, ${env.toolCalls.failed} failed)` : ""}.
          </div>
        </div>
      </ModalShell>
    </>
  );
}
