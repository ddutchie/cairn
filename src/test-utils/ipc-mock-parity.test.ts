/**
 * IPC mock parity guard — every bridge path the renderer's typed clients
 * (`src/lib/ipc/*`) can call must exist on BOTH page-script mocks
 * (tests/fixtures/ipc-mock.ts for smoke/component tests and
 * tests/fixtures/screenshot-fixture.ts for screenshots).
 *
 * Required paths are derived from the client sources themselves (the
 * `(e) => e.foo.bar` callbacks handed to electronCall/domainCall and the
 * `window.electron?.foo?.bar` chains), so adding a new channel to a client
 * without extending the mocks fails here instead of rendering a blank page
 * in screenshots (see: getAiSettings, usage:threads).
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { buildIpcMock } from "../../tests/fixtures/ipc-mock";
import { buildScreenshotMock } from "../../tests/fixtures/screenshot-fixture";

const IPC_DIR = path.join(process.cwd(), "src", "lib", "ipc");

/** Evaluate a mock page script with a bare window and return window.electron. */
function evaluateMock(script: string): Record<string, unknown> {
  const window: Record<string, unknown> = {};
  const sandbox = {
    window,
    Promise,
    Date,
    JSON,
    Object,
    Map,
    Set,
    Array,
    Number,
    Math,
    console: { warn() {}, error() {}, log() {}, info() {} },
  };
  new vm.Script(script).runInNewContext(sandbox);
  return window.electron as Record<string, unknown>;
}

/**
 * Bridge paths the typed clients address, e.g. "getAiSettings",
 * "automation.today.get", "usage.threads". `domain` is the domainCall
 * namespace when the callback runs inside domainCall("ns", …).
 */
/**
 * Bridge paths the renderer's typed clients address, e.g. "getAiSettings",
 * "automation.today.get", "usage.threads". Wrapper consts in src/lib/ipc
 * (app, workspace, …) map 1:1 onto domainCall namespaces, except app which
 * calls top-level bridge keys.
 */
const WRAPPER_NS: Record<string, string | null> = {
  app: null,
  workspace: "workspace",
  project: "project",
  tag: "tag",
  changes: "changes",
  note: "note",
  column: "column",
  card: "card",
  flow: "flow",
  people: "people",
  graph: "graph",
  chat: "chat",
  ai: "ai",
  usage: "usage",
  automation: "automation",
  session: "session",
  tools: "tools",
  secrets: "secrets",
  toolBuilder: "toolBuilder",
  notification: "notification",
  agent: "agent",
  git: "git",
  sync: "sync",
  runtime: "runtime",
  embeddings: "embeddings",
  registry: "registry",
  command: "command",
};

function requiredPaths(): Set<string> {
  const out = new Set<string>();
  const files = fs.readdirSync(IPC_DIR).filter((f) => f.endsWith(".ts"));
  // wrapper((x) => x.foo.bar) — namespace from WRAPPER_NS.
  const wrapperNames = Object.keys(WRAPPER_NS).join("|");
  const wrapperRe = new RegExp(
    `\\b(?:${wrapperNames})\\(\\s*\\(\\w+\\)\\s*=>\\s*\\w+\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`,
    "g",
  );
  // electronCall((e) => e.foo) / domainCall("ns", (a) => a.foo.bar)
  const directRe =
    /\b(?:electronCall|domainCall)\(\s*(?:"([^"]+)",\s*)?\(\w+\)\s*=>\s*\w+\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  // window.electron?.foo?.bar?.baz
  const windowRe = /window\.electron\?\.\s*([A-Za-z_$][\w$]*(?:\?\.[A-Za-z_$][\w$]*)*)/g;
  for (const f of files) {
    const src = fs.readFileSync(path.join(IPC_DIR, f), "utf8");
    for (const m of src.matchAll(wrapperRe)) {
      // The match itself starts with the wrapper call: app((e) => e.foo.
      const w = /^\w+/.exec(m[0])?.[0] ?? null;
      const ns = w ? WRAPPER_NS[w] : null;
      out.add(ns ? `${ns}.${m[1]}` : m[1]);
    }
    for (const m of src.matchAll(directRe)) {
      const [, ns, p] = m;
      out.add(ns ? `${ns}.${p}` : p);
    }
    for (const m of src.matchAll(windowRe)) {
      out.add(m[1].replace(/\?\./g, "."));
    }
  }
  return out;
}

function resolvePath(root: unknown, dotted: string): unknown {
  let cur = root;
  for (const seg of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

describe("ipc mock parity", () => {
  it("derives required paths from the typed clients", () => {
    const paths = requiredPaths();
    // Sanity: the known channels that caused blank pages must be covered.
    for (const p of ["getAiSettings", "usage.threads", "automation.today.get", "snapshot", "command.list"]) {
      expect(paths.has(p), `extraction missed ${p}`).toBe(true);
    }
    expect(paths.size).toBeGreaterThan(50);
  });

  for (const [label, build] of [
    ["ipc-mock", buildIpcMock],
    ["screenshot", buildScreenshotMock],
  ] as const) {
    it(`${label}: every client-addressed path exists as a function`, () => {
      const electron = evaluateMock(build());
      const missing: string[] = [];
      for (const p of requiredPaths()) {
        // Dynamic access (e[domain]) and the platform string are not calls.
        if (p === "platform" || /^[a-z]$/.test(p)) continue;
        const v = resolvePath(electron, p);
        if (typeof v !== "function") missing.push(p);
      }
      expect(missing, `${label} mock is missing:\n  ${missing.join("\n  ")}`).toEqual([]);
    });
  }
});
