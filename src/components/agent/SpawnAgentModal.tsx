"use client";

/**
 * SpawnAgentModal — prompt editor, agent selector, and spawn action.
 *
 * `card` is optional. When omitted (ad-hoc spawn from the Agent view),
 * the task label is hidden, the prompt starts empty, and the session is
 * labelled "Ad-hoc session".
 *
 * Pre-fills from task title + description when a card is provided.
 * On confirm: spawns PTY, adds session to store, navigates to Agent view.
 */

import { useState, useEffect } from "react";
import { Terminal, AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { id } from "@/lib/utils";
import type { TaskCard } from "@/types";

interface SpawnAgentModalProps {
  card?: TaskCard;
  open: boolean;
  onClose: () => void;
}

export function SpawnAgentModal({ card, open, onClose }: SpawnAgentModalProps) {
  const {
    agents, fetchAgents,
    activeProjectId, projects,
    addTerminalSession, setActiveSession, setView, updateProject,
  } = useCairnStore();

  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const codeDirectory = project?.codeDirectory ?? null;

  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

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

  const canSpawn = agents.length > 0 && !!codeDirectory && !!selectedAgentId;
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  async function handleSpawn() {
    if (!canSpawn || !selectedAgent || !codeDirectory || !project) return;
    setSpawning(true);
    setSpawnError(null);

    const taskId = card?.id ?? id();
    const taskTitle = card?.title ?? "Ad-hoc session";

    try {
      const { sessionId } = await window.electron!.agent.spawn({
        agentId: selectedAgent.id,
        projectId: project.id,
        cwd: codeDirectory,
        prompt,
        taskId,
        taskTitle,
      }) as { sessionId: string };
      addTerminalSession({
        sessionId,
        taskId,
        taskTitle,
        agentId: selectedAgent.id,
        agentName: selectedAgent.name,
        projectId: project.id,
        status: "running",
        exitCode: null,
        spawnedAt: new Date().toISOString(),
      });
      setActiveSession(sessionId);
      setView("agent");
      onClose();
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
            <Terminal size={15} />
            {card ? "Spawn Agent" : "New Session"}
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {/* Task label — only shown when launched from a card */}
          {card && (
            <div>
              <p className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Task</p>
              <p className="text-sm font-medium text-[var(--text-primary)]">{card.title}</p>
            </div>
          )}

          {/* No agents warning */}
          {agents.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg p-3 bg-[color-mix(in_srgb,var(--warning,#f59e0b)_10%,transparent)] text-[var(--warning,#f59e0b)]" role="alert">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <div className="text-xs">
                No coding agents configured.{" "}
                <button onClick={() => { onClose(); setView("settings"); }} className="underline">
                  Configure in Settings
                </button>
              </div>
            </div>
          )}

          {/* No code directory warning */}
          {agents.length > 0 && !codeDirectory && (
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

          {/* Agent selector */}
          {agents.length > 0 && (
            <div>
              <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
                Agent
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

          {/* Prompt textarea */}
          <div>
            <label className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-2 font-mono resize-y focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              placeholder="Describe the task for the agent…"
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
              <Terminal size={13} />
              {spawning ? "Spawning…" : card ? "Spawn" : "Start"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
