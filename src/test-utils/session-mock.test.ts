/**
 * session-mock guard — the `window.electron.session` mock must never drift.
 *
 * Two page-script fixtures embed this factory by source
 * (`(${buildSessionMock.toString()})({ noop, makeListener })`):
 * tests/fixtures/ipc-mock.ts (smoke/component tests) and
 * tests/fixtures/screenshot-fixture.ts (marketing screenshots). When the
 * factory gains a method (goal, permissions, subagents, …) but a fixture
 * still inlines its own literal, boot-phase components throw
 * `electron.session.<method> is not a function` — exactly the screenshot
 * failure this guards against.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { buildSessionMock } from "./session-mock";
import { buildIpcMock } from "../../tests/fixtures/ipc-mock";
import { buildScreenshotMock } from "../../tests/fixtures/screenshot-fixture";

const EXPECTED_METHODS = [
  "prompt",
  "onEvent",
  "onProjection",
  "contextRing",
  "title",
  "renameTitle",
  "isRunning",
  "runningIds",
  "abort",
  "clear",
  "destroy",
  "compactNow",
  "setMode",
  "respondTool",
  "respondQuestions",
  "approvePlan",
  "restoreContext",
  "listSessions",
  "createSession",
  "deleteSession",
  "getSessionMessages",
  "getTodos",
  "goal",
  "permissions",
  "feedback",
  "feedbackGet",
  "scheduleList",
  "listSubagents",
  "messageSubagent",
  "interruptSubagent",
  "killJob",
  "listApprovalGrants",
  "deleteApprovalGrant",
  "clearApprovalGrants",
];

function evaluateEmbeddedFactory(): Record<string, (...args: never[]) => unknown> {
  // Evaluate the EXACT artifact fixtures embed: the transformed factory
  // source invoked with stub helpers. new vm.Script throws on syntax
  // errors, so this also proves the embedded source parses as page script.
  const noop = () => Promise.resolve(null);
  const makeListener = (_channel: string) => (_cb: (...args: unknown[]) => void) => () => {};
  const script = new vm.Script(`(${buildSessionMock.toString()})({ noop, makeListener })`);
  return script.runInNewContext({ noop, makeListener, Promise }) as Record<
    string,
    (...args: never[]) => unknown
  >;
}

describe("session-mock factory", () => {
  it("exposes every session method the renderer calls", () => {
    const noop = () => Promise.resolve(null);
    const makeListener = (_channel: string) => (_cb: (...args: unknown[]) => void) => () => {};
    const session = buildSessionMock({ noop, makeListener }) as Record<string, unknown>;
    for (const key of EXPECTED_METHODS) {
      expect(typeof session[key], `session.${key}`).toBe("function");
    }
  });

  it("resolves the boot-phase snapshots components read on mount", async () => {
    const session = evaluateEmbeddedFactory();
    await expect(
      (session.goal as () => Promise<unknown>)(),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      (session.listSubagents as () => Promise<unknown>)(),
    ).resolves.toEqual({ ok: true, value: { entries: [], parentAvailable: false } });
  });

  it("embeds into both page scripts with every method intact", () => {
    // Both builders interpolate the factory by source — assert the emitted
    // page scripts actually carry each method (catches a fixture that
    // reverts to an inline literal or drops the interpolation).
    const ipcScript = buildIpcMock();
    const shotScript = buildScreenshotMock();
    for (const key of EXPECTED_METHODS) {
      expect(ipcScript.includes(`${key}:`), `ipc-mock missing ${key}`).toBe(true);
      expect(shotScript.includes(`${key}:`), `screenshot mock missing ${key}`).toBe(true);
    }
  });
});
