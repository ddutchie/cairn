/**
 * Which IPC channels a paired phone may reach through the Mobile Access
 * `/api/ipc` bridge (`electron/lib/mobile-server.ts` → `getIpcHandler`).
 *
 * The phone loads the full desktop renderer, so it would otherwise reach every
 * channel the desktop window can. This is an allowlist and fails closed:
 *
 *   - Invoke channels: every contract channel must be listed below (the mapped
 *     type makes a new `IpcContract` channel a build error until it is), `true`
 *     = the phone may call it, `false` = desktop window only.
 *   - Send channels (`registerIpcOn`): only those in {@link MOBILE_SEND_CHANNELS}.
 *     Anything else, including a channel added later, is desktop-only.
 *
 * The phone keeps the workspace itself (notes, board, flow, tags, chat and
 * session history, notifications, read-only code views, AI writing helpers).
 * Desktop-only: anything that runs code or a shell (PTYs, git hooks, MCP
 * servers, plugins, automation scripts), edits files in a code directory,
 * reads/writes secrets or sends a stored key to a caller-chosen URL, changes
 * approvals or permissions, reconfigures the app, workspace, sync, runtimes or
 * Mobile Access itself, or opens desktop-only windows and dialogs.
 */

import type { IpcChannel } from "../../shared/ipc/contract";

export const MOBILE_INVOKE: { readonly [C in IpcChannel]: boolean } = {
  // ── Chat pop-out windows (desktop-only window management) ──
  "chat:popOut": false,
  "chat:popoutReady": false,
  "chat:requestPopIn": false,
  "chat:popIn": false,

  // ── Chat + session history ──
  "db:chat:threads": true,
  "db:chat:sessionMessages": true,
  "db:chat:upsertThread": true,
  "db:chat:deleteThread": true,
  "db:chat:clearThreadMessages": true,
  "db:chat:clearAllThreads": true,
  "chat:compactThread": true,
  "chat:summarizeTranscript": true,
  "db:session:list": true,
  "db:session:create": true,
  "db:session:delete": true,
  "db:session:todos": true,
  "db:session:messages": true,
  "session:is-running": true,
  "session:running-ids": true,
  "session:context-ring": true,
  "session:title": true,
  "session:renameTitle": true,
  "session:permissions": true,
  "session:permissions:set": false, // could widen what the agent runs without asking
  "subagent:list": true,
  "subagent:interrupt": true,
  "subagent:message": true,
  "session:job-kill": true,
  "session:goal": true,
  "session:feedback": true,
  "session:feedback-get": true,
  "session:schedule-list": true,
  "cordis:listCommands": true,
  "cordis:executeCommand": false, // slash commands run with the desktop agent config

  // ── Workspace data ──
  "db:workspace:list": true,
  "db:workspace:create": true,
  "db:workspace:update": true,
  "db:project:list": true,
  "db:project:create": true,
  "db:project:update": true,
  "db:project:updateSettings": true,
  "db:project:delete": true,
  "db:project:merge": true,
  "db:column:list": true,
  "db:column:create": true,
  "db:column:update": true,
  "db:column:delete": true,
  "db:card:list": true,
  "db:card:create": true,
  "db:card:update": true,
  "db:card:moveToProject": true,
  "db:card:delete": true,
  "db:cards:archive-done": true,
  "db:card:addBlocker": true,
  "db:card:removeBlocker": true,
  "db:card:ready": true,
  "db:tag:list": true,
  "db:tag:create": true,
  "db:tag:update": true,
  "db:tag:delete": true,
  "db:note:list": true,
  "db:note:create": true,
  "db:note:update": true,
  "db:note:delete": true,
  "db:note:moveToFolder": true,
  "db:note:moveToProject": true,
  "db:note:bodies:get": true,
  "db:note:search": true,
  "db:note:backlinks:list": true,
  "db:note:changeMark:clear": true,
  "db:flow:get": true,
  "db:flow:node:create": true,
  "db:flow:node:update": true,
  "db:flow:node:delete": true,
  "db:flow:node:summarize": true,
  "db:flow:edge:create": true,
  "db:flow:edge:delete": true,
  "db:flow:url:fetch": true,
  "db:snapshot": true,
  "db:changes:get": true,
  "db:hasData": true,
  "db:mcpQuery": true,
  "db:command:list": true,
  "db:command:create": true,
  "db:command:update": true,
  "db:command:delete": true,
  "db:graph:get": true,
  "db:graph:neighbors": true,
  "db:graph:recompute": true,
  "db:notification:list": true,
  "db:notification:count": true,
  "db:notification:markRead": true,
  "db:notification:clear": true,
  "mcp:markNotificationsRead": true,

  // ── Automations: read-only on the phone (they run scripts and agent turns) ──
  "db:automation:list": true,
  "db:automation:get": true,
  "db:automation:create": false,
  "db:automation:update": false,
  "db:automation:delete": false,
  "db:automation:runs": true,
  "db:automation:recentRuns": true,
  "db:automation:runningCount": true,
  "db:automation:checkRequirements": true,
  "db:automation:budget:get": true,
  "db:automation:budget:set": false,
  "db:automation:runNow": false,
  "automation:approve": false, // approves a pending tool call
  "db:automation:folder": false, // creates the folder on disk
  "db:automation:files": true,
  "db:automation:runLog": true,
  "db:automation:syncFromManifest": false,
  "db:automation:env": false, // automation secrets
  "db:automation:env:set": false,
  "db:automation:env:delete": false,
  "db:automation:preview": true,

  // ── Git: reads only (commit/checkout/push run repo hooks) ──
  "git:status": true,
  "git:branches": true,
  "git:checkout": false,
  "git:stage": false,
  "git:unstage": false,
  "git:commit": false,
  "git:push": false,
  "git:log": true,
  "git:diff": true,
  "git:diffBranch": true,
  "git:diffFile": true,
  "git:stash": false,
  "git:createPr": false,
  "git:prStatus": true,
  "git:discard": false,

  // ── MCP servers + custom services (spawn processes, hold credentials) ──
  "tools:listMcpServers": false,
  "tools:saveMcpServer": false,
  "tools:deleteMcpServer": false,
  "tools:testMcp": false,
  "tools:listMcpTools": false,
  "tools:startMcpAuth": false,
  "tools:mcpAuthStatus": false,
  "tools:signOutMcp": false,
  "tools:cancelMcpAuth": false,
  "tools:listServices": false,
  "tools:saveService": false,
  "tools:deleteService": false,
  "tools:testService": false,
  "tools:startServiceAuth": false,
  "tools:serviceAuthStatus": false,
  "tools:signOutService": false,
  "tools:cancelServiceAuth": false,
  "tools:listAttachments": false,
  "tools:setAttachment": false,
  "tools:clearAttachment": false,

  // ── Secrets ──
  "secrets:available": true,
  "secrets:has": true,
  "secrets:set": false,
  "secrets:delete": false,

  // ── App + workspace configuration ──
  "app:selectWorkspaceFolder": false,
  "app:getWorkspacePath": true,
  "app:needsWorkspaceSetup": true,
  "app:initWorkspace": false,
  "app:rescanWorkspace": false,
  "app:rollbackImport": false,
  "app:probeWorkspaceFolder": false,
  "app:checkMigrations": true,
  "app:runMigration": false,
  "app:reset": false,
  "app:relaunch": false,
  "app:isDev": true,
  "app:mcpServerPath": true,
  "app:latestChangelog": true,
  "app:setTheme": true,
  "app:setAccent": true,
  "app:revealNote": false, // opens Finder on the desktop
  "app:revealAssets": false,
  "app:uploadAsset": true,
  "app:exportNotePdf": true,
  "app:exportMarkdown": true,
  "app:llmLeftovers": true,
  "app:clearLlmLeftovers": false,
  "app:getAiSettings": true,
  "app:saveAiSettings": false, // could point the stored key at another endpoint
  "app:getAgentSettings": true,
  "app:saveAgentSettings": false,
  "app:getTheme": true,
  "app:saveTheme": true,
  "app:getFontScale": true,
  "app:saveFontScale": true,
  "app:getEmbeddingsSettings": true,
  "app:saveEmbeddingsSettings": false,
  "app:modelPricing": true,
  "app:noTemperatureModels": true,
  "updater:install": false,

  // ── AI helpers ──
  "ai:generatePrd": true,
  "ai:generateCommitMessage": true,
  "ai:generatePrDescription": true,
  "ai:explainArchitecture": true,
  "ai:fetchModels": false, // sends a stored key to a caller-chosen base URL
  "ai:fetchKeyInfo": false,

  // ── Coding agent: code views read-only; no PTYs, file writes or agent config ──
  "agent:getCodingAgents": true,
  "agent:saveCodingAgent": false,
  "agent:deleteCodingAgent": false,
  "agent:setDefaultAgent": false,
  "agent:readDir": true,
  "agent:searchFiles": true,
  "agent:readFile": true,
  "agent:readFileBase64": true,
  "agent:writeFile": false,
  "agent:validateDirectory": true,
  "agent:gitDiff": true,
  "agent:pickDirectory": false, // native dialogs open on the desktop
  "agent:pickFile": false,
  "agent:codebaseOverview": true,
  "agent:codebaseGraph": true,
  "agent:codebaseModuleGraph": true,
  "agent:codebaseFileSymbols": true,
  "agent:codebaseRelations": true,
  "agent:codebaseReindex": true,
  "agent:codebaseReindexFile": true,
  "agent:spawn": false,
  "agent:spawnShell": false,
  "agent:input": false,
  "agent:resize": false,
  "agent:kill": false,
  "agent:modelTerminals": true,

  // ── Usage ──
  "usage:overview": true,
  "usage:recent": true,
  "usage:threads": true,
  "usage:clear": false,

  // ── Writing style ──
  "user-style:get": true,
  "user-style:save": true,
  "user-style:clear": true,
  "user-style:generate": true,

  // ── Approval grants ──
  "approval-grants:list": false,
  "approval-grants:delete": false,
  "approval-grants:clear-workspace": false,

  // ── Sync ──
  "sync:getFolder": false,
  "sync:selectFolder": false,
  "sync:clearFolder": false,
  "sync:now": false,
  "sync:status": false,
  "sync:pendingBreakdown": false,
  "sync:listConflicts": false,
  "sync:resolveConflict": false,
  "sync:activity": false,
  "sync:peerProtocols": false,
  "sync:listRestorable": false,
  "sync:restoreNote": false,
  "sync:repairNoteFile": false,

  // ── Community registry (fixed upstream URLs) ──
  "registry:fetch": true,
  "registry:refresh": true,
  "registry:fetchProviders": true,
  "registry:refreshProviders": true,
  "registry:fetchAutomations": true,
  "registry:refreshAutomations": true,
  "registry:fetchPersonalities": true,
  "registry:refreshPersonalities": true,
  "registry:fetchChatThemes": true,
  "registry:refreshChatThemes": true,

  // ── Plugins (install/update fetch and run third-party code) ──
  "plugins:listUi": false,
  "plugins:list": false,
  "plugins:setEnabled": false,
  "plugins:openFolder": false,
  "plugins:install": false,
  "plugins:update": false,
  "plugins:uninstall": false,

  // ── Embeddings + runtimes: status and search only ──
  "embeddings:status": true,
  "embeddings:stop": false,
  "embeddings:needsReindex": true,
  "embeddings:projections": true,
  "db:embeddings:reindex": true,
  "db:embeddings:search": true,
  "db:embeddings:recomputeProjections": true,
  "embeddings:models:list": true,
  "embeddings:models:install": false,
  "embeddings:models:remove": false,
  "embeddings:models:setDefault": false,
  "runtime:status": true,
  "runtime:stop": false,
  "runtime:embeddings:status": true,
  "runtime:embeddings:ensureStarted": false,
  "runtime:embeddings:models": true,
  "runtime:embeddings:install": false,
  "runtime:embeddings:remove": false,
  "runtime:embeddings:setDefault": false,
  "runtime:systemPrompt:preview": true,
  "runtime:codingPrompt:preview": true,
  "runtime:tools:inventory": true,

  // ── Mobile Access itself ──
  "mobile:status": true,
  "mobile:saveSettings": false,
  "mobile:regeneratePin": false,
};

/**
 * `registerIpcOn` (fire-and-forget `send`) channels the phone may reach. Agent
 * turns are allowed; tool and question answers carry an approval nonce that is
 * stripped from everything sent to mobile, so the phone cannot approve them.
 * Desktop-only: `app:openExternal` (opens a browser on the desktop) and the
 * `tool-builder:*` channels (build tool definitions with secrets).
 */
export const MOBILE_SEND_CHANNELS: ReadonlySet<string> = new Set([
  "session:prompt",
  "session:abort",
  "session:approve-plan",
  "session:compact-now",
  "session:set-mode",
  "session:respond-tool",
  "session:respond-questions",
  "session:clear",
  "session:destroy",
  "session:restore-context",
  "user-style:generateStream",
  "user-style:abort",
]);

/** May the Mobile Access bridge call `channel`? Unknown channels are refused. */
export function isMobileChannel(channel: string): boolean {
  if (Object.prototype.hasOwnProperty.call(MOBILE_INVOKE, channel)) {
    return MOBILE_INVOKE[channel as IpcChannel];
  }
  return MOBILE_SEND_CHANNELS.has(channel);
}
