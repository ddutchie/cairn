"use client";

import React, { useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, Loader2, TerminalSquare, User, XCircle } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Automation } from "@/store/slices/automations";

/**
 * RunWatcherModal — "step into" a running automation. Subscribes to the live
 * automation:run events for a runId and renders a chat-like transcript:
 * the recipe it's following, streaming assistant tokens, thinking, and tool
 * calls as they happen. Lets you see exactly why a run did (or didn't) do
 * what the script was supposed to.
 */
export function RunWatcherModal({
  automation,
  runId,
  onClose,
}: {
  automation: Automation | null;
  runId: string | null;
  onClose: () => void;
}) {
  interface ToolChip {
    key: string;
    name: string;
    label: string;
    status: "running" | "done" | "error";
    output?: string;
  }

  const [recipe, setRecipe] = useState<string | null>(null);
  const [assistant, setAssistant] = useState("");
  const [thought, setThought] = useState("");
  const [tools, setTools] = useState<ToolChip[]>([]);
  const [finished, setFinished] = useState(false);
  const [approval, setApproval] = useState<{ tool: string; callId: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRecipe(null); setAssistant(""); setThought(""); setTools([]); setFinished(false); setApproval(null); /* eslint-disable-line react-hooks/set-state-in-effect */
    if (!runId || !window.electron?.automation.onRunEvent) return;
    const toolSeq = { n: 0 };
    return window.electron.automation.onRunEvent((e) => {
      if (e.runId !== runId) return;
      switch (e.event) {
        case "started": setRecipe(e.recipe ?? ""); break;
        case "token": setAssistant((p) => p + (e.delta ?? "")); break;
        case "thought": setThought((p) => p + (e.delta ?? "")); break;
        case "tool": {
          // Compute the key + sequence OUTSIDE the updater — React may invoke
          // updaters twice in StrictMode, so mutating toolSeq.n inside would
          // skip keys and leave the counter inconsistent.
          const key = `${e.tool}:${toolSeq.n++}`;
          setTools((p) => [...p, { key, name: e.tool ?? "?", label: e.label ?? e.tool ?? "tool", status: "running" }]);
          break;
        }
        case "toolDone":
          setTools((p) => p.map((t) =>
            t.name === e.tool && t.status === "running"
              ? { ...t, status: e.ok ? "done" : "error", output: e.output }
              : t,
          ));
          break;
        case "approval":
          if (e.callId) setApproval({ tool: e.tool ?? "tool", callId: e.callId });
          break;
        case "finished": setFinished(true); setApproval(null); break;
      }
    });
  }, [runId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [assistant, tools.length, thought]);

  const isLive = !finished && runId !== null;

  return (
    <ModalShell
      open={automation !== null && runId !== null}
      onClose={onClose}
      size="xl"
      title={
        automation ? (
          <span className="flex items-center gap-2">
            <TerminalSquare size={13} className="text-[var(--accent)]" />
            <span className="truncate">Watching: {automation.name}</span>
            {isLive && <Loader2 size={11} className="animate-spin text-[var(--accent)]" />}
          </span>
        ) : ""
      }
      footer={
        <>
          {finished && (
            <span className="text-xs text-[var(--ok)] flex items-center gap-1 mr-auto">
              <CheckCircle2 size={12} /> Run finished
            </span>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Close</Button>
          </DialogClose>
        </>
      }
    >
      <div ref={scrollRef} className="h-[55vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 space-y-3 text-sm">
        {recipe && (
          <div className="flex gap-2 items-start">
            <User size={13} className="text-[var(--text-tertiary)] mt-0.5 shrink-0" />
            <div className="whitespace-pre-wrap text-[var(--text-primary)] min-w-0">{recipe}</div>
          </div>
        )}

        {tools.map((t) => (
          <div key={t.key} className="flex gap-2 items-start">
            <TerminalSquare size={13} className={cn("mt-0.5 shrink-0", t.status === "running" ? "text-[var(--accent)]" : t.status === "error" ? "text-[var(--danger)]" : "text-[var(--ok)]")} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[0.714rem] text-[var(--text-secondary)]">{t.label}</span>
                {t.status === "running" && <Loader2 size={10} className="animate-spin text-[var(--accent)]" />}
                {t.status === "done" && <CheckCircle2 size={10} className="text-[var(--ok)]" />}
                {t.status === "error" && <XCircle size={10} className="text-[var(--danger)]" />}
              </div>
              {t.output && (
                <pre className="mt-1 text-[0.714rem] text-[var(--text-tertiary)] whitespace-pre-wrap font-mono max-h-40 overflow-y-auto rounded bg-[var(--surface-2)] p-2">
                  {t.output}
                </pre>
              )}
            </div>
          </div>
        ))}

        {(assistant || thought) && (
          <div className="flex gap-2 items-start">
            <Bot size={13} className="text-[var(--accent)] mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              {thought && (
                <details className="mb-1">
                  <summary className="text-[0.714rem] text-[var(--text-tertiary)] cursor-pointer select-none">
                    Thinking
                  </summary>
                  <pre className="mt-1 text-[0.714rem] text-[var(--text-tertiary)] whitespace-pre-wrap font-mono max-h-40 overflow-y-auto rounded bg-[var(--surface-2)] p-2">
                    {thought}
                  </pre>
                </details>
              )}
              <div className={cn("whitespace-pre-wrap min-w-0", assistant ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]")}>
                {assistant || (isLive ? "…" : "")}
                {isLive && assistant && <span className="inline-block w-1.5 h-3.5 bg-[var(--accent)] align-middle animate-pulse ml-0.5" />}
              </div>
            </div>
          </div>
        )}

        {approval && (
          <div className="rounded-lg border border-[var(--accent)] bg-[var(--accent)]/10 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <Bot size={13} className="text-[var(--accent)] shrink-0" />
              <span>
                The agent wants to run <span className="font-mono text-[0.714rem]">{approval.tool}</span> — this tool requires your approval.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => { window.electron?.automation.approve(approval.callId, true); setApproval(null); }}>
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => { window.electron?.automation.approve(approval.callId, true, "always"); setApproval(null); }}>
                Always allow
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { window.electron?.automation.approve(approval.callId, false); setApproval(null); }}>
                Deny
              </Button>
            </div>
          </div>
        )}

        {!recipe && !assistant && tools.length === 0 && (
          <p className="text-xs text-[var(--text-tertiary)]">{isLive ? "Waiting for activity…" : "No live activity."}</p>
        )}
      </div>
    </ModalShell>
  );
}
