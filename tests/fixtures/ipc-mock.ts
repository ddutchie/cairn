/**
 * IPC mock injected into the browser page via page.addInitScript().
 *
 * This file is serialised and evaluated in the browser context — it must be
 * self-contained (no imports). The function returned by `buildIpcMock` is
 * stringified and passed to addInitScript so it runs before any page JS.
 *
 * The mock covers every channel accessed by the store's hydrateFromElectron()
 * boot path plus all channels that view components call during render.
 */

// ── Fixture data ──────────────────────────────────────────────────────────────

// Build-time only: the session factory's SOURCE is embedded into the page
// script (the page itself stays import-free). See src/test-utils/session-mock.
import { buildSessionMock } from "../../src/test-utils/session-mock";

export const WS_ID = "ws-1";
export const PROJ_ID = "proj-1";
export const COL_BACKLOG = "col-backlog";
export const COL_TODO = "col-todo";
export const COL_INPROG = "col-inprog";
export const COL_REVIEW = "col-review";
export const COL_DONE = "col-done";
export const CARD_1 = "card-1";
export const CARD_2 = "card-2";
export const NOTE_1 = "note-1";
export const TAG_1 = "tag-1";
export const NOW = "2026-05-05T00:00:00.000Z";

export const FIXTURE_SNAPSHOT = {
  workspaces: [
    {
      id: WS_ID,
      name: "Test Workspace",
      description: "E2E fixture workspace",
      icon: "🪨",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  projects: [
    {
      id: PROJ_ID,
      workspaceId: WS_ID,
      name: "Test Project",
      description: "E2E fixture project",
      icon: "📋",
      status: "active",
      priority: "medium",
      tagIds: [TAG_1],
      codeDirectory: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  notes: [
    {
      id: NOTE_1,
      projectId: PROJ_ID,
      workspaceId: WS_ID,
      title: "Fixture Note",
      content: "# Fixture Note\n\nThis is a test note.",
      contentText: "Fixture Note This is a test note.",
      tagIds: [],
      linkedNoteIds: [],
      linkedCardIds: [CARD_1],
      isPinned: false,
      type: "note",
      folder: "",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  columns: [
    { id: COL_BACKLOG, projectId: PROJ_ID, workspaceId: WS_ID, name: "Backlog",     type: "backlog",     order: 0, createdAt: NOW, updatedAt: NOW },
    { id: COL_TODO,    projectId: PROJ_ID, workspaceId: WS_ID, name: "To Do",       type: "todo",        order: 1, createdAt: NOW, updatedAt: NOW },
    { id: COL_INPROG,  projectId: PROJ_ID, workspaceId: WS_ID, name: "In Progress", type: "in_progress", order: 2, createdAt: NOW, updatedAt: NOW },
    { id: COL_REVIEW,  projectId: PROJ_ID, workspaceId: WS_ID, name: "Review",      type: "review",      order: 3, createdAt: NOW, updatedAt: NOW },
    { id: COL_DONE,    projectId: PROJ_ID, workspaceId: WS_ID, name: "Done",        type: "done",        order: 4, createdAt: NOW, updatedAt: NOW },
  ],
  cards: [
    {
      id: CARD_1,
      columnId: COL_TODO,
      projectId: PROJ_ID,
      workspaceId: WS_ID,
      title: "Fix the bug",
      description: "Reproduce and fix the reported crash",
      tagIds: [TAG_1],
      priority: "high",
      dueDate: "2026-06-01",
      linkedNoteIds: [NOTE_1],
      blockedByIds: [],
      order: 0,
      assignee: "Alice",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: CARD_2,
      columnId: COL_DONE,
      projectId: PROJ_ID,
      workspaceId: WS_ID,
      title: "Write tests",
      description: "Add Playwright smoke tests",
      tagIds: [],
      priority: "medium",
      linkedNoteIds: [],
      blockedByIds: [],
      order: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  tags: [
    { id: TAG_1, name: "bug", color: "#ef4444", workspaceId: WS_ID },
  ],
};

export const FIXTURE_GRAPH = {
  nodes: [
    { id: PROJ_ID, type: "project", title: "Test Project", workspaceId: WS_ID },
    { id: NOTE_1,  type: "note",    title: "Fixture Note",  projectId: PROJ_ID, workspaceId: WS_ID },
    { id: CARD_1,  type: "card",    title: "Fix the bug",   projectId: PROJ_ID, workspaceId: WS_ID },
    { id: TAG_1,   type: "tag",     title: "bug",            workspaceId: WS_ID },
  ],
  edges: [
    { id: "e1", source: PROJ_ID, target: NOTE_1, type: "project-member" },
    { id: "e2", source: PROJ_ID, target: CARD_1, type: "project-member" },
    { id: "e3", source: NOTE_1,  target: CARD_1, type: "note-card"      },
    { id: "e4", source: CARD_1,  target: TAG_1,  type: "tag-member"     },
  ],
};

export const FIXTURE_FLOW = {
  nodes: [
    {
      id: "fn-1",
      projectId: PROJ_ID,
      type: "idea",
      data: { title: "Core idea", body: "The main concept" },
      x: 100, y: 100, width: 200, height: 80,
      createdAt: NOW, updatedAt: NOW,
    },
  ],
  edges: [],
};

// ── Script builder ────────────────────────────────────────────────────────────

/**
 * Returns a stringified script that, when evaluated in the browser, installs
 * a `window.electron` shim covering all IPC channels the app uses on boot
 * and during view rendering.
 *
 * Pass the result to `page.addInitScript({ content: buildIpcMock() })`.
 *
 * `opts.needsWorkspaceSetup` overrides the default fresh-install probe so the
 * value is baked into the same synchronous script that defines `window.electron`
 * — avoiding a race where the app reads the default before a deferred override
 * runs.
 */
export function buildIpcMock(opts?: { needsWorkspaceSetup?: boolean }): string {
  // Embed fixture data as JSON so the script is fully self-contained
  const snapshot = JSON.stringify(FIXTURE_SNAPSHOT);
  const graph = JSON.stringify(FIXTURE_GRAPH);
  const flow = JSON.stringify(FIXTURE_FLOW);
  const wsId = JSON.stringify(WS_ID);
  const projId = JSON.stringify(PROJ_ID);
  const needsSetup = JSON.stringify(opts?.needsWorkspaceSetup ?? false);

  return /* js */ `
(function () {
  const snap = ${snapshot};
  const graphData = ${graph};
  const flowData = ${flow};
  const wsId = ${wsId};
  const projId = ${projId};
  const needsSetup = ${needsSetup};

  // No-op that returns a resolved promise (used for write calls)
  const noop = () => Promise.resolve(null);

  // Event-listener registry for push channels (onDbChanged, onAiWriteStarted…).
  //
  // Each channel keeps a live Set of registered callbacks. Tests can drive the
  // preload push flow by calling window.__cairnEmit(channel, payload), which
  // invokes every registered callback for that channel — mirroring how the real
  // electron/preload.ts forwards ipcRenderer events to subscribers.
  const __listeners = {};
  function makeListener(channel) {
    if (!__listeners[channel]) __listeners[channel] = new Set();
    return (cb) => {
      __listeners[channel].add(cb);
      // Return an unsubscribe fn, matching the preload contract.
      return () => { __listeners[channel].delete(cb); };
    };
  }
  // Test bridge: emit a payload to all subscribers of a channel.
  window.__cairnEmit = (channel, payload) => {
    const set = __listeners[channel];
    if (!set) return 0;
    for (const cb of set) cb(payload);
    return set.size;
  };

  window.electron = {
    // ── Boot sequence ────────────────────────────────────────
    snapshot:              () => Promise.resolve(snap),
    hasData:               () => Promise.resolve(true),
    changes:               { get: () => Promise.resolve(null) },
    command:               { list: () => Promise.resolve([]), create: noop, update: noop, delete: noop },

    // ── Extended coverage (parity with preload API; see ipc-mock-parity.test.ts) ──
    git: { status: () => Promise.resolve({ branch: "main", ahead: "0", behind: "0", hasUpstream: false, defaultBranch: "main", staged: [], unstaged: [], untracked: [] }), branches: () => Promise.resolve({ current: "main", branches: [] }), checkout: noop, stage: noop, unstage: noop, commit: () => Promise.resolve({ ok: true }), push: noop, log: () => Promise.resolve([]), diff: () => Promise.resolve(""), diffBranch: () => Promise.resolve(""), diffFile: () => Promise.resolve(""), stash: noop, createPr: () => Promise.resolve(null), prStatus: () => Promise.resolve(null), discard: noop },
    embeddings: { getSettings: () => Promise.resolve(null), saveSettings: noop, status: () => Promise.resolve(null), needsReindex: () => Promise.resolve(false), reindex: noop, stop: noop, search: () => Promise.resolve([]), projections: () => Promise.resolve([]), recomputeProjections: noop, models: { install: noop, list: () => Promise.resolve([]), remove: noop, setDefault: noop, onProgress: makeListener("embeddings.models.onProgress") } },
    sync: { status: () => Promise.resolve({ state: "disabled", pending: 0, conflicts: 0, lastSyncAt: null, connected: false }), pendingBreakdown: () => Promise.resolve(null), onStatus: makeListener("sync.onStatus"), listConflicts: () => Promise.resolve([]), resolveConflict: noop, activity: () => Promise.resolve([]), listRestorable: () => Promise.resolve([]), restoreNote: noop, repairNoteFile: noop, getFolder: () => Promise.resolve(null), selectFolder: () => Promise.resolve(null), clearFolder: noop, now: () => Promise.resolve(Date.now()), peerProtocols: () => Promise.resolve([]) },
    runtime: { status: () => Promise.resolve(null), stop: noop, onProgress: makeListener("runtime.onProgress"), embeddings: { ensureStarted: noop, install: noop, remove: noop, setDefault: noop, models: () => Promise.resolve([]), status: () => Promise.resolve(null), onProgress: makeListener("runtime.embeddings.onProgress") }, sandboxStatus: () => Promise.resolve(null), listCommands: () => Promise.resolve([]), executeCommand: noop, toolsInventory: () => Promise.resolve([]), systemPromptPreview: () => Promise.resolve(""), codingPromptPreview: () => Promise.resolve("") },
    registry: { fetch: () => Promise.resolve([]), refresh: () => Promise.resolve([]), fetchProviders: () => Promise.resolve([]), fetchAutomations: () => Promise.resolve([]), fetchChatThemes: () => Promise.resolve([]), fetchPersonalities: () => Promise.resolve([]), refreshProviders: noop, refreshAutomations: noop, refreshChatThemes: noop, refreshPersonalities: noop },
    needsWorkspaceSetup:   () => Promise.resolve(needsSetup),

    // ── Workspace ─────────────────────────────────────────────
    workspace: {
      list:   () => Promise.resolve(snap.workspaces),
      create: noop,
      update: noop,
    },

    // ── Projects ─────────────────────────────────────────────
    project: {
      list:   () => Promise.resolve(snap.projects),
      create: noop,
      update: noop,
      updateSettings: noop,
      delete: noop,
      merge:  noop,
    },

    // ── Notes ─────────────────────────────────────────────────
    note: {
      list:         () => Promise.resolve(snap.notes),
      create:       noop,
      update:       noop,
      delete:       noop,
      moveToFolder: noop,
      moveToProject: noop,
      bodies:       (ids) => Promise.resolve(snap.notes.filter((n) => ids.indexOf(n.id) >= 0).map((n) => ({ id: n.id, content: n.content }))),
      search:       () => Promise.resolve([]),
      searchSnippets: () => Promise.resolve([]),
      backlinks:    () => Promise.resolve([]),
      clearChangeMark: noop,
    },

    // ── Board columns ─────────────────────────────────────────
    column: {
      list:   () => Promise.resolve(snap.columns),
      create: noop,
      update: noop,
      delete: noop,
    },

    // ── Task cards ────────────────────────────────────────────
    card: {
      list:          () => Promise.resolve(snap.cards),
      create:        noop,
      update:        noop,
      delete:        noop,
      addBlocker:    noop,
      removeBlocker: noop,
      ready:         () => Promise.resolve(snap.cards),
      moveToProject: noop,
      archiveDone:   () => Promise.resolve([]),
    },

    // ── Idea Flow ─────────────────────────────────────────────
    flow: {
      get:  () => Promise.resolve(flowData),
      node: { create: noop, update: noop, delete: noop, summarize: noop },
      edge: { create: noop, delete: noop },
      url:  { fetch: () => Promise.resolve({ title: "", description: "" }) },
    },

    // ── People layer (flag off) ───────────────────────────────
    people: {
      flag:      { get: () => Promise.resolve(false), set: (on) => Promise.resolve(!!on) },
      list:      () => Promise.resolve([]),
      summaries: () => Promise.resolve([]),
      network:   () => Promise.resolve({ edges: [], coAttendance: [] }),
      get:       () => Promise.resolve(null),
      page:      () => Promise.resolve(null),
      create:    noop,
      update:    noop,
      delete:    noop,
      relations: () => Promise.resolve([]),
      edge:      { add: noop, update: noop, remove: noop },
      meetings:  () => Promise.resolve([]),
      mentionNoteIds: () => Promise.resolve([]),
      ownedCardIds:   () => Promise.resolve([]),
      attendees: () => Promise.resolve([]),
      attendee:  { add: noop, remove: noop },
    },

    // ── Tags ──────────────────────────────────────────────────
    tag: {
      list:   () => Promise.resolve(snap.tags),
      create: noop,
      update: noop,
      delete: noop,
    },

    // ── Chat ──────────────────────────────────────────────────
    chat: {
      threads:        () => Promise.resolve([]),
      messages:       () => Promise.resolve([]),
      sessionMessages: () => Promise.resolve([]),
      upsertThread:   noop,
      addMessage:     noop,
      deleteThread:   noop,
      clearThreadMessages: noop,
      clearAllThreads: noop,
      compactThread:  () => Promise.resolve(null),
      summarizeTranscript: () => Promise.resolve(null),
      popOut:         noop,
      popoutReady:    noop,
      popIn:          noop,
      requestPopIn:   noop,
      stream:         () => {},
      abort:          () => {},
      onToken:        makeListener("chat.onToken"),
      onDone:         makeListener("chat.onDone"),
      onToolCall:     makeListener("chat.onToolCall"),
      onToolCallDone: makeListener("chat.onToolCallDone"),
      onUsage:        makeListener("chat.onUsage"),
      onChatPoppedIn: makeListener("chat.onChatPoppedIn"),
      onChatPoppedOutClosed: makeListener("chat.onChatPoppedOutClosed"),
      onChatRequestPopIn: makeListener("chat.onChatRequestPopIn"),
      onChatSessionUpdated: makeListener("chat.onChatSessionUpdated"),
    },

    // ── Knowledge graph ───────────────────────────────────────
    graph: {
      get:       () => Promise.resolve(graphData),
      neighbors: () => Promise.resolve({ nodes: [], edges: [] }),
      recompute: noop,
    },

    // ── Usage (empty in smoke runs; screenshots seed real series) ──
    usage: {
      overview: () => Promise.resolve(null),
      recent:   () => Promise.resolve([]),
      threads:  () => Promise.resolve([]),
      clear:    noop,
      setPricing: noop,
      setNoTemperatureModels: noop,
      setEndpointProtocols: noop,
    },

    // ── AI helpers ────────────────────────────────────────────
    ai: {
      generatePrd: noop,
      generateCommitMessage: () => Promise.resolve(""),
      generatePrDescription: () => Promise.resolve(""),
      explainArchitecture: () => Promise.resolve(""),
      fetchModels: () => Promise.resolve([]),
      fetchKeyInfo: () => Promise.resolve(null),
      probeProtocols: () => Promise.resolve([]),
    },

    // ── App helpers ───────────────────────────────────────────
    mcpServerPath:         () => Promise.resolve("/mock/mcp-server"),
    latestChangelog:       () => Promise.resolve(null),
    llmLeftovers:          () => Promise.resolve([]),
    clearLlmLeftovers:     noop,
    revealNote:            noop,
    exportNotePdf:         noop,
    exportMarkdown:        noop,
    openExternal:          () => {},
    uploadAsset:           () => Promise.resolve({ assetUrl: "" }),
    revealAssets:          noop,
    selectWorkspaceFolder: () => Promise.resolve(null),
    getWorkspacePath:      () => Promise.resolve("/mock/workspace"),
    needsWorkspaceSetup:   () => Promise.resolve(needsSetup),
    isDev:                 () => Promise.resolve(true),
    setTheme:              noop,
    setAccent:             noop,
    initWorkspace:         () => Promise.resolve({ ok: true }),
    rescanWorkspace:       () => Promise.resolve({ projectsCreated: 0, createdProjects: [] }),
    rollbackImport:        noop,
    probeWorkspaceFolder:  () => Promise.resolve({ isObsidianVault: false, vaultName: "Notes", noteCount: 0, skippedCount: 0, projects: [], excludedFolders: [] }),
    relaunch:              noop,
    resetAllData:          noop,
    getAiSettings:         () => Promise.resolve(null),
    saveAiSettings:        noop,
    getAgentSettings:      () => Promise.resolve(null),
    saveAgentSettings:     noop,
    getTheme:              () => Promise.resolve(null),
    saveTheme:             noop,
    getFontScale:          () => Promise.resolve(null),
    saveFontScale:         noop,
    checkMigrations:       () => Promise.resolve([]),
    runMigration:          noop,
    onMigrationProgress:   makeListener("app.migrationProgress"),
    onQuickCapture:        makeListener("app.quickCapture"),
    onSpellcheckContext:   makeListener("spellcheck.context"),
    spellcheckReplace:     noop,
    spellcheckAddWord:     noop,
    platform:              "darwin",

    // ── Automations (empty in smoke runs) ───────────────────────
    automation: {
      list: () => Promise.resolve([]),
      create: noop, update: noop, delete: noop,
      runs: () => Promise.resolve([]), recentRuns: () => Promise.resolve([]),
      runningCount: () => Promise.resolve(0), runNow: () => Promise.resolve({ runId: "run-mock" }),
      preview: () => Promise.resolve({ nextRunAt: new Date(Date.now()+3600*1000).toISOString() }),
      approve: noop, pendingApprovals: () => Promise.resolve({ approvals: [] }),
      budget: { get: () => Promise.resolve({ budgetUsd: null, spentTodayUsd: 0 }), set: noop },
      folder: () => Promise.resolve({ folder: "/mock/automations/mock" }),
      syncFromManifest: noop, runLog: () => Promise.resolve({ log: {} }), files: () => Promise.resolve([]),
      env: { get: () => Promise.resolve([]), set: () => Promise.resolve([]), delete: () => Promise.resolve([]) },
      checkRequirements: () => Promise.resolve([]),
      onRunEvent: makeListener("automation:run"),
      today: {
        get: () => Promise.resolve({ automationId: null, enabled: false, time: "07:00", weekdaysOnly: true, nextRunAt: null, running: false, activity: null, brief: null, marks: { done: [], edits: {} }, lastError: null, settings: { excludedProjects: [], excludedApps: [], webApps: [] }, projects: [], facts: [], apps: [] }),
        enable: noop, disable: noop, settings: noop,
        mark: () => Promise.resolve({ done: [], edits: {} }),
        history: () => Promise.resolve([]), snapshot: () => Promise.resolve(null),
        run: () => Promise.resolve({ skipped: true }), route: () => Promise.resolve({ target: null, tools: [] }),
        export: () => Promise.resolve(null), onUpdated: makeListener("today:updated"),
      },
    },

    // ── Auto-updater ──────────────────────────────────────────
    updater: {
      onUpdateAvailable: makeListener("updater.onUpdateAvailable"),
      onUpdateDownloaded: makeListener("updater.onUpdateDownloaded"),
      install: noop,
    },

    // ── Push events ───────────────────────────────────────────
    onDbChanged:               makeListener("onDbChanged"),
    onMcpUnreadCount:          makeListener("onMcpUnreadCount"),
    markMcpNotificationsRead:  noop,
    notification: {
      list:       () => Promise.resolve([]),
      count:      () => Promise.resolve(0),
      markRead:   noop,
      markAllRead: noop,
      clear:      noop,
    },

    // ── AI write-lock events (note editor + db:changed override) ──
    onAiWriteStarted:          makeListener("onAiWriteStarted"),
    onAiWriteEnded:            makeListener("onAiWriteEnded"),

    // ── Agent ─────────────────────────────────────────────────
    agent: {
      getCodingAgents:  () => Promise.resolve([]),
      revealPath:       noop,
      searchFiles:      () => Promise.resolve([]),
      codebaseOverview: () => Promise.resolve(null),
      codebaseGraph:    () => Promise.resolve(null),
      codebaseModuleGraph: () => Promise.resolve(null),
      codebaseFileSymbols: () => Promise.resolve([]),
      codebaseRelations: () => Promise.resolve([]),
      codebaseReindex:  noop,
      codebaseReindexFile: noop,
      modelTerminals:   () => Promise.resolve([]),
      saveCodingAgent:  noop,
      deleteCodingAgent: noop,
      setDefaultAgent:  noop,
      readDir:          () => Promise.resolve([]),
      readFile:         () => Promise.resolve(""),
      readFileBase64:   () => Promise.resolve(""),
      writeFile:        noop,
      validateDirectory: () => Promise.resolve(true),
      gitDiff:          () => Promise.resolve(""),
      pickDirectory:    () => Promise.resolve(null),
      pickFile:         () => Promise.resolve(null),
      spawn:            () => Promise.resolve({ sessionId: "mock-session" }),
      input:            noop,
      resize:           noop,
      spawnShell:       () => Promise.resolve({ sessionId: "mock-shell-session" }),
      kill:             () => Promise.resolve(),
      onData:           makeListener("agent.onData"),
      onExit:           makeListener("agent.onExit"),
      onModelTerminal:  makeListener("agent.onModelTerminal"),
    },

    // ── Cairn native agent (pi) — agent/dsh unified session ─────────────────
    // Single source of truth: src/test-utils/session-mock.ts (embedded by
    // source so the page script stays import-free).
    session: (${buildSessionMock.toString()})({ noop, makeListener }),
    tools: {
      listMcpServers:  () => Promise.resolve([]),
      saveMcpServer:   noop,
      deleteMcpServer: noop,
      testMcp:         () => Promise.resolve({ ok: true, toolCount: 0, toolNames: [] }),
      listMcpTools:    () => Promise.resolve({ ok: true, tools: [] }),
      listServices:    () => Promise.resolve([]),
      saveService:     noop,
      deleteService:   noop,
      testService:     () => Promise.resolve({ ok: true }),
      listAttachments: () => Promise.resolve([]),
      setAttachment:   noop,
      clearAttachment: noop,
      startMcpAuth:    () => Promise.resolve({ status: "already_authorized" }),
      mcpAuthStatus:   () => Promise.resolve({ connected: false }),
      signOutMcp:      noop,
      cancelMcpAuth:   () => Promise.resolve({ cancelled: false }),
      startServiceAuth:   () => Promise.resolve({ status: "already_authorized" }),
      serviceAuthStatus:  () => Promise.resolve({ connected: false }),
      signOutService:     noop,
      cancelServiceAuth:  () => Promise.resolve({ cancelled: false }),
      onOauthCallback: makeListener("tools.onOauthCallback"),
      onAuthRequired: makeListener("tools.onAuthRequired"),
    },

    // ── User writing style ──────────────────────────────────────
    getUserStyle: () => Promise.resolve(null),
    saveUserStyle: noop,
    clearUserStyle: noop,
    generateUserStyle: () => Promise.resolve(""),
    generateUserStyleStream: noop,
    abortUserStyleStream: noop,
    onUserStyleToken: makeListener("userStyle.onUserStyleToken"),
    onUserStyleToolCall: makeListener("userStyle.onUserStyleToolCall"),
    onUserStyleToolCallDone: makeListener("userStyle.onUserStyleToolCallDone"),
    onUserStyleDone: makeListener("userStyle.onUserStyleDone"),

    // ── Secrets (OS keychain) ─────────────────────────────────
    secrets: {
      available: () => Promise.resolve(false),
      set:       () => Promise.resolve(""),
      has:       () => Promise.resolve(false),
      delete:    noop,
    },

    // ── AI Tool Builder ───────────────────────────────────────
    toolBuilder: {
      prompt:       () => {},
      abort:        () => {},
      end:          () => {},
      onToken:      makeListener("toolBuilder.onToken"),
      onStep:       makeListener("toolBuilder.onStep"),
      onProbeHost:  makeListener("toolBuilder.onProbeHost"),
      onProposal:   makeListener("toolBuilder.onProposal"),
      onDone:       makeListener("toolBuilder.onDone"),
    },
  };
})();
`;
}
