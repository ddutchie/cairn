"use client";

import { useCallback, useEffect, useState } from "react";
import { useCairnStore } from "@/store";

export interface InventoryToolView {
  name: string;
  description: string;
  category: string;
  source: string;
  gated?: boolean;
}

export type InventorySurfaces = Record<string, InventoryToolView[]>;

interface PreviewsState {
  workspacePath: string | null;
  systemPrompt: string | null;
  sections: Array<{ name: string; text: string; index: number }> | null;
  skillNames: Array<{ name: string; description: string }>;
  globalToolNames: Array<{ name: string; description?: string }>;
  codingPrompt: string | null;
  inventory: InventorySurfaces | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Shared loader for the AI Settings tabs (Chat / Coding Agents / MCP).
 * Fetches the live Cordis prompt assembly, the coding-agent prompt, and the
 * per-surface tool inventory in parallel. Each tab renders only its slice —
 * Chat shows the chat prompt + chat tools, Coding Agents the coding prompt +
 * coding/automation-dev tools, MCP the server config + MCP tools.
 */
export function useAgentPreviews(): PreviewsState {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [sections, setSections] = useState<Array<{ name: string; text: string; index: number }> | null>(null);
  const [skillNames, setSkillNames] = useState<Array<{ name: string; description: string }>>([]);
  const [globalToolNames, setGlobalToolNames] = useState<Array<{ name: string; description?: string }>>([]);
  const [codingPrompt, setCodingPrompt] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventorySurfaces | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.electron?.getWorkspacePath().then((p) => setWorkspacePath(p ?? null));
  }, []);

  const load = useCallback(async () => {
    if (!workspacePath) return;
    setLoading(true);
    setError(null);
    try {
      const promptRes = await window.electron?.runtime?.systemPromptPreview({ cwd: workspacePath });
      if (promptRes) {
        if (promptRes.error) setError(promptRes.error);
        setSystemPrompt(promptRes.text || null);
        setSections(promptRes.sections);
        setSkillNames(promptRes.skills ?? []);
        setGlobalToolNames(promptRes.tools ?? []);
      }
      try {
        const { projects: ps, activeProjectId: ap } = useCairnStore.getState();
        const projName = ps.find((p) => p.id === ap)?.name ?? ps[0]?.name;
        const codingRes = await window.electron?.runtime?.codingPromptPreview?.({
          cwd: workspacePath,
          projectName: projName,
        });
        if (codingRes && !codingRes.error) setCodingPrompt(codingRes.text || null);
      } catch { /* informational — chat preview still answers */ }
      try {
        const invRes = await window.electron?.runtime?.toolsInventory?.();
        if (invRes?.surfaces) setInventory(invRes.surfaces);
        else if (invRes?.error) setError((prev) => prev ?? invRes.error ?? null);
      } catch { /* informational — legacy global list still answers */ }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  // Auto-load on mount and when deps change
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return {
    workspacePath,
    systemPrompt,
    sections,
    skillNames,
    globalToolNames,
    codingPrompt,
    inventory,
    loading,
    error,
    reload: load,
  };
}
