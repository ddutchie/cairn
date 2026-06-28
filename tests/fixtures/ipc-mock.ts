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
    { id: PROJ_ID,  type: "project", label: "Test Project",  data: FIXTURE_SNAPSHOT.projects[0] },
    { id: NOTE_1,   type: "note",    label: "Fixture Note",  data: FIXTURE_SNAPSHOT.notes[0] },
    { id: CARD_1,   type: "card",    label: "Fix the bug",   data: FIXTURE_SNAPSHOT.cards[0] },
    { id: TAG_1,    type: "tag",     label: "bug",            data: FIXTURE_SNAPSHOT.tags[0] },
  ],
  edges: [
    { id: "e1", source: PROJ_ID, target: NOTE_1, type: "has_note" },
    { id: "e2", source: PROJ_ID, target: CARD_1, type: "has_card" },
    { id: "e3", source: NOTE_1,  target: CARD_1, type: "linked"   },
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
      delete: noop,
    },

    // ── Notes ─────────────────────────────────────────────────
    note: {
      list:         () => Promise.resolve(snap.notes),
      create:       noop,
      update:       noop,
      delete:       noop,
      moveToFolder: noop,
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
    },

    // ── Idea Flow ─────────────────────────────────────────────
    flow: {
      get:  () => Promise.resolve(flowData),
      node: { create: noop, update: noop, delete: noop, summarize: noop },
      edge: { create: noop, delete: noop },
      url:  { fetch: () => Promise.resolve({ title: "", description: "" }) },
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
      upsertThread:   noop,
      addMessage:     noop,
      deleteThread:   noop,
      stream:         () => {},
      abort:          () => {},
      onToken:        makeListener("chat.onToken"),
      onDone:         makeListener("chat.onDone"),
      onToolCall:     makeListener("chat.onToolCall"),
      onToolCallDone: makeListener("chat.onToolCallDone"),
      onUsage:        makeListener("chat.onUsage"),
    },

    // ── Knowledge graph ───────────────────────────────────────
    graph: {
      get:       () => Promise.resolve(graphData),
      neighbors: () => Promise.resolve({ nodes: [], edges: [] }),
      recompute: noop,
    },

    // ── AI helpers ────────────────────────────────────────────
    ai: {
      generatePrd: noop,
    },

    // ── App helpers ───────────────────────────────────────────
    mcpServerPath:         () => Promise.resolve("/mock/mcp-server"),
    latestChangelog:       () => Promise.resolve(null),
    revealNote:            noop,
    openExternal:          () => {},
    uploadAsset:           () => Promise.resolve({ assetUrl: "" }),
    revealAssets:          noop,
    selectWorkspaceFolder: () => Promise.resolve(null),
    getWorkspacePath:      () => Promise.resolve("/mock/workspace"),
    needsWorkspaceSetup:   () => Promise.resolve(needsSetup),
    setTheme:              noop,
    initWorkspace:         () => Promise.resolve({ requiresRestart: false }),
    relaunch:              noop,
    resetAllData:          noop,
    platform:              "darwin",

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

    // ── AI write-lock events (note editor + db:changed override) ──
    onAiWriteStarted:          makeListener("onAiWriteStarted"),
    onAiWriteEnded:            makeListener("onAiWriteEnded"),

    // ── Dashboard live query bridge ───────────────────────────
    mcpQuery: (_tool, _args) => Promise.resolve(null),

    // ── Agent ─────────────────────────────────────────────────
    agent: {
      getCodingAgents:  () => Promise.resolve([]),
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
    },

    // ── Cairn native agent (pi) ───────────────────────────────────────────────
    piAgent: {
      prompt:         noop,
      abort:          noop,
      clear:          noop,
      destroy:        noop,
      approvePlan:    noop,
      restoreContext: noop,
      listSessions:   () => Promise.resolve([]),
      createSession:  noop,
      deleteSession:  noop,
      getMessages:    () => Promise.resolve([]),
      saveMessages:   noop,
      onToken:        makeListener("piAgent.onToken"),
      onTool:         makeListener("piAgent.onTool"),
      onDone:         makeListener("piAgent.onDone"),
      onError:        makeListener("piAgent.onError"),
      onToolsReady:   makeListener("piAgent.onToolsReady"),
      onStep:         makeListener("piAgent.onStep"),
      onUsage:        makeListener("piAgent.onUsage"),
      onSubagent:     makeListener("piAgent.onSubagent"),
      onPlanNote:     makeListener("piAgent.onPlanNote"),
      onNoteUpdated:  makeListener("piAgent.onNoteUpdated"),
      onModeChange:   makeListener("piAgent.onModeChange"),
    },

    // ── External tools (MCP servers + custom HTTP services) ───
    tools: {
      listMcpServers:  () => Promise.resolve([]),
      saveMcpServer:   noop,
      deleteMcpServer: noop,
      testMcp:         () => Promise.resolve({ ok: true, toolCount: 0, toolNames: [] }),
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
      onOauthCallback: makeListener("tools.onOauthCallback"),
    },

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
