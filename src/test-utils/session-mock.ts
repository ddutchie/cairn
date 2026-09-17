/**
 * Shared `window.electron.session` mock factory for page-script fixtures.
 *
 * Both `tests/fixtures/ipc-mock.ts` (smoke/component tests) and
 * `tests/fixtures/screenshot-fixture.ts` (marketing screenshots) inject a
 * `window.electron` shim into pages via `addInitScript`. Each hand-maintained
 * its own `session:` literal, so newly added session methods (goal,
 * permissions, subagents, …) crashed whichever mock drifted behind with
 * `electron.session.<method> is not a function` on component mount.
 *
 * This factory is the single source of truth. Fixtures embed it with
 * `(${buildSessionMock.toString()})({ noop, makeListener })`, evaluated in
 * page scope with the page's own helpers.
 *
 * EMBED CONTRACT (enforced by session-mock.test.ts): `.toString()` runs on
 * the *transformed* function, so TypeScript annotations are fine — but the
 * body must avoid runtime transform-sensitive syntax and must reference
 * nothing outside its params plus page globals (Promise, Object, …).
 */

export interface SessionMockHelpers {
  noop: () => Promise<null>;
  makeListener: (channel: string) => (cb: (...args: unknown[]) => void) => () => void;
}

export function buildSessionMock({ noop, makeListener }: SessionMockHelpers) {
  return {
    prompt: noop,
    onEvent: makeListener("session:onEvent"),
    onProjection: makeListener("session:onProjection"),
    contextRing: () => Promise.resolve({ available: false }),
    title: () => Promise.resolve({ title: null }),
    renameTitle: () => Promise.resolve({ title: "Mock Title" }),
    isRunning: () => Promise.resolve({ running: false, pendingQuestions: [], pendingAsks: [] }),
    runningIds: () => Promise.resolve({ ids: [] }),
    abort: noop,
    clear: noop,
    destroy: noop,
    compactNow: noop,
    setMode: noop,
    respondTool: noop,
    respondQuestions: noop,
    approvePlan: noop,
    restoreContext: noop,
    listSessions: () => Promise.resolve([]),
    createSession: noop,
    deleteSession: noop,
    getSessionMessages: () => Promise.resolve([]),
    getTodos: () => Promise.resolve([]),
    goal: () => Promise.resolve({ ok: true, value: null }),
    permissions: () => Promise.resolve({ ok: false, code: "unavailable", message: "mock" }),
    feedback: () => Promise.resolve({ ok: true, value: { messageId: "mock", rating: "positive", version: "1" } }),
    feedbackGet: () => Promise.resolve({ ok: true, value: null }),
    scheduleList: () => Promise.resolve({ ok: true, value: [] }),
    listSubagents: () => Promise.resolve({ ok: true, value: { entries: [], parentAvailable: false } }),
    messageSubagent: () => Promise.resolve({ ok: true, value: { messageId: "mock" } }),
    interruptSubagent: () => Promise.resolve({ ok: true, value: { accepted: false } }),
    killJob: () => Promise.resolve({ ok: true, value: null }),
    listApprovalGrants: () => Promise.resolve([]),
    deleteApprovalGrant: noop,
    clearApprovalGrants: noop,
  };
}
