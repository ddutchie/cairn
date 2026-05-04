/**
 * Coding Agents slice.
 *
 * Manages the global registry of AI coding agent CLI configurations
 * (e.g. Claude Code, OpenCode, Aider). Persisted to coding_agents table
 * in SQLite via the agent:* IPC channels.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodingAgent {
  id: string;
  name: string;
  binaryPath: string;
  args: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CodingAgentsSlice {
  agents: CodingAgent[];

  fetchAgents: () => Promise<void>;
  saveAgent: (agent: Omit<CodingAgent, "createdAt" | "updatedAt">) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  setDefaultAgent: (id: string) => Promise<void>;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createCodingAgentsSlice: StateCreator<CairnStore, [], [], CodingAgentsSlice> = (
  set,
  _get
) => ({
  agents: [],

  async fetchAgents() {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const result = await window.electron.agent.getCodingAgents();
      if (result && "data" in result) {
        set({ agents: result.data as CodingAgent[] });
      }
    } catch (err) {
      console.error("[coding-agents] fetchAgents error", err);
    }
  },

  async saveAgent(agent) {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const result = await window.electron.agent.saveCodingAgent(agent);
      if (result && "data" in result) {
        const saved = result.data as CodingAgent;
        set((s) => ({
          agents: s.agents.some((a) => a.id === saved.id)
            ? s.agents.map((a) => (a.id === saved.id ? saved : a))
            : [...s.agents, saved],
        }));
      }
    } catch (err) {
      console.error("[coding-agents] saveAgent error", err);
    }
  },

  async deleteAgent(agentId) {
    if (typeof window === "undefined" || !window.electron) return;
    // Optimistic
    set((s) => ({ agents: s.agents.filter((a) => a.id !== agentId) }));
    try {
      await window.electron.agent.deleteCodingAgent(agentId);
    } catch (err) {
      console.error("[coding-agents] deleteAgent error", err);
    }
  },

  async setDefaultAgent(agentId) {
    if (typeof window === "undefined" || !window.electron) return;
    // Optimistic: flip flags locally
    set((s) => ({
      agents: s.agents.map((a) => ({ ...a, isDefault: a.id === agentId })),
    }));
    try {
      await window.electron.agent.setDefaultAgent(agentId);
    } catch (err) {
      console.error("[coding-agents] setDefaultAgent error", err);
    }
  },
});
