"use client";

/**
 * SpawnAgentModal — prompt editor, agent selector, and spawn action.
 *
 * `card` is optional. When omitted (ad-hoc spawn from the Agent view),
 * the task label is hidden, the prompt starts empty, and the session is
 * labelled "Ad-hoc session".
 *
 * Session types:
 *   "pi"  — Cairn native agent (structured chat, no PTY)
 *   "pty" — External PTY agent (xterm.js terminal)
 */

import { useState, useEffect } from "react";
import { Terminal, MessageSquare, AlertTriangle, Zap, Map as MapIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { id } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { TaskCard } from "@/types";

interface SpawnAgentModalProps {
  card?: TaskCard;
  open: boolean;
  onClose: () => void;
}

export function SpawnAgentModal({ card, open, onClose }: SpawnAgentModalProps) {
  const {
    agents, fetchAgents, activeProjectId, projects,
    addTerminalSession, setActiveSession, setView, updateProject, aiConfig,
  } = useCairnStore(useShallow((s) => ({
    agents:               s.agents,
    fetchAgents:          s.fetchAgents,
    activeProjectId:      s.activeProjectId,
    projects:             s.projects,
    addTerminalSession:   s.addTerminalSession,
    setActiveSession:     s.setActiveSession,
    setView:              s.setView,
    updateProject:        s.updateProject,
    aiConfig:             s.aiConfig,
  })));

  const project      = projects.find((p) => p.id === activeProjectId) ?? null;
  const codeDirectory = project?.codeDirectory ?? null;

  const [sessionType, setSessionType]   = useState<"pi" | "pty">("pi");
  const [agentMode, setAgentMode]       = useState<"execute" | "plan">("execute");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [prompt, setPrompt]             = useState("");
  const [spawning, setSpawning]         = useState(false);
  const [spawnError, setSpawnError]     = useState<string | null>(null);

  // Fetch agents on open
  useEffect(() => {
    if (open) fetchAgents();
  }, [open, fetchAgents]);

  // Default agent + initial prompt
  useEffect(() => {
    if (!open) return;
    const defaultAgent = agents.find((a) => a.isDefault) ?? agents[0];
    if (defaultAgent) setSelectedAgentId(defaultAgent.id);
    if (card) {
      const desc = card.description ? `\n\n${card.description}` : "";
      setPrompt(`Task: ${card.title}${desc}`);
    } else {
      setPrompt("");
    }
    setSpawnError(null);
  }, [open, agents, card]);

  const canSpawnPty = agents.length > 0 && !!codeDirectory && !!selectedAgentId && !!window.electron;
  const canSpawnPi  = !!codeDirectory && !!window.electron;
  const canSpawn    = sessionType === "pi" ? canSpawnPi : canSpawnPty;

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  async function handleSpawn() {
    if (!canSpawn || !codeDirectory || !project) return;
    setSpawning(true);
    setSpawnError(null);

    const sessionId  = id();
    const taskId     = card?.id ?? id();
    const taskTitle  = card?.title ?? "Ad-hoc session";

    try {
      if (sessionType === "pi") {
        // Cairn native agent — no PTY, just create the session and send initial prompt
        addTerminalSession({
          sessionId,
          taskId,
          taskTitle,
          agentId:       "cairn-agent",
          agentName:     "Cairn Agent",
          projectId:     project.id,
          cwd:           codeDirectory,
          status:        "running",
          exitCode:      null,
          spawnedAt:     new Date().toISOString(),
          sessionType:   "pi",
          piMessages:    [],
          mode:          agentMode,
          // Store the prompt — PiAgentPane will fire it on first mount
          initialPrompt: prompt.trim() || undefined,
        });

        setActiveSession(sessionId);
        setView("agent");
        onClose();

      } else {
        // External PTY agent
        if (!selectedAgent) return;
        const { sessionId: ptySessionId } = await window.electron!.agent.spawn({
          agentId:   selectedAgent.id,
          projectId: project.id,
          cwd:       codeDirectory,
          prompt,
          taskId,
          taskTitle,
        });
        addTerminalSession({
          sessionId:   ptySessionId,
          taskId,
          taskTitle,
          agentId:     selectedAgent.id,
          agentName:   selectedAgent.name,
          projectId:   project.id,
          cwd:         codeDirectory,
          status:      "running",
          exitCode:    null,
          spawnedAt:   new Date().toISOString(),
          sessionType: "pty",
        });
        setActiveSession(ptySessionId);
        setView("agent");
        onClose();
      }
    } catch (e) {
      setSpawnError(String(e));
    } finally {
      setSpawning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {sessionType === "pi"
              ? <MessageSquare size={15} />
              : <Terminal size={15} />}
            {card ? "Spawn Agent" : "New Session"}
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">

          {/* Session type toggle */}
          <div>
            <p className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-1.5">
              Agent type
            </p>
            <div className="flex rounded-lg border border-[var(--border)] overflow-hidden text-xs">
              <button
                onClick={() => setSessionType("pi")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors",
                  sessionType === "pi"
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                )}
              >
                <MessageSquare size={12} />
                Cairn Agent
              </button>
              <button
                onClick={() => setSessionType("pty")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors border-l border-[var(--border)]",
                  sessionType === "pty"
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                )}
              >
                <Terminal size={12} />
                External Agent
              </button>
            </div>
            {sessionType === "pi" && (
              <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1">
                Uses {aiConfig.model || "gpt-4o"} · reads/writes code + Cairn board
              </p>
            )}
          </div>

          {/* Plan / Execute mode toggle — Cairn Agent only */}
          {sessionType === "pi" && (
            <div>
              <p className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-1.5">
                Mode
              </p>
              <div className="flex rounded-lg border border-[var(--border)] overflow-hidden text-xs">
                <button
                  onClick={() => setAgentMode("execute")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors",
                    agentMode === "execute"
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                  )}
                >
                  <Zap size={12} />
                  Execute
                </button>
                <button
                  onClick={() => setAgentMode("plan")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors border-l border-[var(--border)]",
                    agentMode === "plan"
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                  )}
                >
                  <MapIcon size={12} />
                  Plan
                </button>
              </div>
              <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1">
                {agentMode === "plan"
                  ? "Discuss and refine a plan first — no code written until you approve"
                  : "Jump straight into implementation"}
              </p>
            </div>
          )}

          {/* Task label — only shown when launched from a card */}
          {card && (
            <div>
              <p className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Task</p>
              <p className="text-sm font-medium text-[var(--text-primary)]">{card.title}</p>
            </div>
          )}

          {/* No code directory warning */}
          {!codeDirectory && (
            <div className="flex items-start gap-2 rounded-lg p-3 bg-[color-mix(in_srgb,var(--warning,#f59e0b)_10%,transparent)] text-[var(--warning,#f59e0b)]" role="alert">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <div className="text-xs">
                No code directory set for this project.{" "}
                <button
                  className="underline"
                  onClick={async () => {
                    if (!project) return;
                    const result = await window.electron?.agent.pickDirectory() as { data: string | null } | undefined;
                    if (result?.data) updateProject(project.id, { codeDirectory: result.data });
                  }}
                >
                  Choose folder
                </button>
              </div>
            </div>
          )}

          {/* PTY-specific: agent selector */}
          {sessionType === "pty" && (
            <>
              {agents.length === 0 ? (
                <div className="flex items-start gap-2 rounded-lg p-3 bg-[color-mix(in_srgb,var(--warning,#f59e0b)_10%,transparent)] text-[var(--warning,#f59e0b)]" role="alert">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <div className="text-xs">
                    No coding agents configured.{" "}
                    <button onClick={() => { onClose(); setView("settings"); }} className="underline">
                      Configure in Settings
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
                    Agent binary
                  </label>
                  <select
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}{a.isDefault ? " (default)" : ""}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {/* Prompt textarea */}
          <div>
            <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
              {sessionType === "pi" && agentMode === "plan" ? "What do you want to build?" : sessionType === "pi" ? "Initial prompt (optional)" : "Prompt"}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) handleSpawn(); }}
              rows={5}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-2 font-mono resize-y focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              placeholder={
                sessionType === "pi" && agentMode === "plan"
                  ? "Describe what you want to build — the agent will ask questions and build a plan…"
                  : sessionType === "pi"
                  ? "Describe what you want the agent to do…"
                  : "Describe the task for the agent…"
              }
            />
          </div>

          {/* Spawn error */}
          {spawnError && (
            <div className="text-xs text-[var(--danger)] rounded-lg p-2 bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]" role="alert">
              {spawnError}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleSpawn}
              disabled={!canSpawn || spawning}
            >
              {sessionType === "pi" ? <MessageSquare size={13} /> : <Terminal size={13} />}
              {spawning ? "Starting…" : card ? "Spawn" : "Start"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
