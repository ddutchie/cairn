/** External tools (MCP servers, custom services), secrets, community registry, AI Tool Builder. */

import { invokeContract, onIpcEvent, sendContract } from "./ipc";
import type { IpcEvents } from "../../shared/ipc/contract";
import type { ToolBuilderDoneEvent, ToolBuilderProbeHostEvent, ToolBuilderPromptRequest, ToolBuilderProposalEvent, ToolBuilderStepEvent, ToolBuilderTokenEvent } from "../../shared/types/tool-builder";
import type { CustomServiceConfig, McpServerConfig, SecretToolType, ToolAttachment } from "../../shared/types/tools";

export const toolsApi = {
  // ── External tools (MCP servers + custom HTTP services) ───────
  tools: {
    listMcpServers: (workspaceId: string) => invokeContract("tools:listMcpServers", { workspaceId }),
    saveMcpServer: (server: Partial<McpServerConfig>) => invokeContract("tools:saveMcpServer", server),
    deleteMcpServer: (id: string) => invokeContract("tools:deleteMcpServer", { id }),
    testMcp: (id: string) => invokeContract("tools:testMcp", { id }),
    listMcpTools: (id: string) => invokeContract("tools:listMcpTools", { id }),

    listServices: (workspaceId: string) => invokeContract("tools:listServices", { workspaceId }),
    saveService: (service: Partial<CustomServiceConfig>) => invokeContract("tools:saveService", service),
    deleteService: (id: string) => invokeContract("tools:deleteService", { id }),
    testService: (id: string, sampleArgs?: Record<string, unknown>) =>
      invokeContract("tools:testService", { id, sampleArgs }),

    listAttachments: (projectId: string) => invokeContract("tools:listAttachments", { projectId }),
    setAttachment: (a: ToolAttachment) => invokeContract("tools:setAttachment", a),
    clearAttachment: (a: Omit<ToolAttachment, "enabled">) => invokeContract("tools:clearAttachment", a),

    // OAuth (remote MCP servers gated behind an authorization page).
    startMcpAuth: (id: string) => invokeContract("tools:startMcpAuth", { id }),
    mcpAuthStatus: (id: string) => invokeContract("tools:mcpAuthStatus", { id }),
    signOutMcp: (id: string) => invokeContract("tools:signOutMcp", { id }),
    /** Cancel an in-flight OAuth sign-in (user abandoned the browser step). */
    cancelMcpAuth: (id: string) => invokeContract("tools:cancelMcpAuth", { id }),

    // OAuth for custom HTTP services (same flow as MCP, no transport).
    startServiceAuth: (id: string) => invokeContract("tools:startServiceAuth", { id }),
    serviceAuthStatus: (id: string) => invokeContract("tools:serviceAuthStatus", { id }),
    signOutService: (id: string) => invokeContract("tools:signOutService", { id }),
    cancelServiceAuth: (id: string) => invokeContract("tools:cancelServiceAuth", { id }),
    /** Fires when a sign-in finishes (loopback listener or cairn://oauth/callback deep link). */
    onOauthCallback: (cb: (e: IpcEvents["tools:oauthCallback"]) => void) => onIpcEvent("tools:oauthCallback", cb),
  },

  // ── Secrets (OS keychain). No get() by design — renderer only learns set/not-set.
  secrets: {
    available: () => invokeContract("secrets:available"),
    set: (toolType: SecretToolType, toolId: string, key: string, value: string) =>
      invokeContract("secrets:set", { toolType, toolId, key, value }),
    has: (toolType: SecretToolType, toolId: string, key: string) =>
      invokeContract("secrets:has", { toolType, toolId, key }),
    delete: (toolType: SecretToolType, toolId: string, key: string) =>
      invokeContract("secrets:delete", { toolType, toolId, key }),
  },

  // ── Community registry (cairn-community catalog) ──────────────
  registry: {
    /** Cache-first: instant/offline, background-revalidates. */
    fetch: () => invokeContract("registry:fetch"),
    /** Force a network refresh (explicit Refresh button). */
    refresh: () => invokeContract("registry:refresh"),
    /** Community AI providers (separate providers.json manifest). Cache-first. */
    fetchProviders: () => invokeContract("registry:fetchProviders"),
    /** Force a network refresh of the providers manifest. */
    refreshProviders: () => invokeContract("registry:refreshProviders"),
    /** Community automation recipes (separate automations.json manifest). Cache-first. */
    fetchAutomations: () => invokeContract("registry:fetchAutomations"),
    /** Force a network refresh of the automations manifest. */
    refreshAutomations: () => invokeContract("registry:refreshAutomations"),
    /** Community personalities (separate personalities.json manifest). Cache-first. */
    fetchPersonalities: () => invokeContract("registry:fetchPersonalities"),
    /** Force a network refresh of the personalities manifest. */
    refreshPersonalities: () => invokeContract("registry:refreshPersonalities"),
    /** Community chat themes (separate themes.json manifest). Cache-first. */
    fetchChatThemes: () => invokeContract("registry:fetchChatThemes"),
    /** Force a network refresh of the chat themes manifest. */
    refreshChatThemes: () => invokeContract("registry:refreshChatThemes"),
  },

  // ── AI Tool Builder (streaming builder session) ───────────────
  toolBuilder: {
    /** Send a builder prompt (and optionally a user-supplied secret). Fire-and-forget. */
    prompt: (req: ToolBuilderPromptRequest) => sendContract("tool-builder:prompt", req),
    /** Abort the current in-flight builder turn. */
    abort: (sessionId: string) => sendContract("tool-builder:abort", { sessionId }),
    /** Destroy a builder session (clears its in-memory state + temp secrets). */
    end: (sessionId: string) => sendContract("tool-builder:end", { sessionId }),

    onToken: (cb: (e: ToolBuilderTokenEvent) => void) => onIpcEvent("tool-builder:token", cb),
    onStep: (cb: (e: ToolBuilderStepEvent) => void) => onIpcEvent("tool-builder:step", cb),
    onProbeHost: (cb: (e: ToolBuilderProbeHostEvent) => void) => onIpcEvent("tool-builder:probe-host", cb),
    onProposal: (cb: (e: ToolBuilderProposalEvent) => void) => onIpcEvent("tool-builder:proposal", cb),
    onDone: (cb: (e: ToolBuilderDoneEvent) => void) => onIpcEvent("tool-builder:done", cb),
  },
} as const;
