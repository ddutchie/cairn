/**
 * Workspace-rebind guard
 *
 * `reinitialise()` (electron/main.ts) swaps the workspace *in place* — it points
 * `ctx.db` / `ctx.workspacePath` at a new SQLite file without relaunching the
 * app. Every IPC registrar must therefore read `ctx.db` at CALL time. A
 * registrar that takes a bare `db: Database` parameter captures the handle in a
 * closure at REGISTRATION time and is then permanently bound to whichever DB
 * happened to exist at boot.
 *
 * This is not a theoretical concern. It shipped as a real bug: on a fresh
 * install `main.ts` boots with a throwaway `<userData>/cairn/cairn.db` (no
 * `workspace-config.json` yet), the onboarding wizard calls `app:initWorkspace`
 * → `reinitialise()`, and every by-value registrar kept talking to the empty
 * throwaway DB until the app was restarted. For chat that meant
 * `get_full_snapshot` returned an empty workspace, every write tool failed with
 * "Project not found", and any note that *did* get written landed in a hidden
 * directory — i.e. "chat is not connected to my workspace until I restart".
 *
 * These tests are deliberately source-level. The failure mode is invisible to a
 * behavioural test (a stale handle is a perfectly valid, working DB — just the
 * wrong one), so we assert the calling convention itself.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const IPC_DIR = __dirname;
const MAIN_TS = path.resolve(IPC_DIR, "..", "main.ts");

/**
 * Registrars that must accept a `DbContext` (or an object whose `db` is a live
 * getter) rather than a bare `Database`. Each entry is the exported function
 * name as it appears in `electron/ipc/*` / `electron/**`.
 */
const CTX_REGISTRARS = [
  "registerChatHandler",
  "registerAgentHandlers",
  "registerToolsHandlers",
  "registerGitHandlers",
  "registerToolBuilderHandlers",
] as const;

function readIpcSources(): Array<{ file: string; src: string }> {
  return fs
    .readdirSync(IPC_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(IPC_DIR, f), "utf8") }));
}

describe("workspace-rebind guard — registrars take DbContext, not a bare Database", () => {
  const sources = readIpcSources();

  for (const name of CTX_REGISTRARS) {
    it(`${name} accepts ctx: DbContext`, () => {
      const hit = sources.find((s) => s.src.includes(`export function ${name}(`));
      expect(hit, `could not find "export function ${name}(" in electron/ipc/*`).toBeDefined();

      // Grab the parameter list (handles single- and multi-line signatures).
      const start = hit!.src.indexOf(`export function ${name}(`);
      const openParen = hit!.src.indexOf("(", start);
      const closeParen = hit!.src.indexOf(")", openParen);
      const params = hit!.src.slice(openParen + 1, closeParen);

      expect(
        params,
        `${name} (${hit!.file}) must take "ctx: DbContext" so it reads ctx.db at call time. ` +
          `Capturing a Database by value breaks reinitialise() — see this file's header.`,
      ).toMatch(/ctx:\s*DbContext/);

      // A bare `db: Database` parameter is exactly the regression we're guarding.
      expect(
        params,
        `${name} (${hit!.file}) still declares a bare "db: Database" parameter.`,
      ).not.toMatch(/\bdb\s*:\s*Database\b/);
    });
  }

  it("main.ts passes ctx (not ctx.db) to every context-bound registrar", () => {
    const main = fs.readFileSync(MAIN_TS, "utf8");
    for (const name of CTX_REGISTRARS) {
      const callRe = new RegExp(`${name}\\(([^)]*)\\)`, "g");
      for (const m of main.matchAll(callRe)) {
        const args = m[1];
        // Skip the import statement / type positions — only real call sites have args.
        if (args.includes("ctx.db")) {
          throw new Error(
            `main.ts calls ${name}(${args}) — passing ctx.db captures the handle by ` +
              `value and survives a workspace swap. Pass ctx instead.`,
          );
        }
      }
    }
    expect(main).not.toMatch(/register\w+Handlers?\(ctx\.db/);
  });

  it("registerIpcHandlers passes ctx to registerChatHandler", () => {
    const handlers = fs.readFileSync(path.join(IPC_DIR, "handlers.ts"), "utf8");
    expect(handlers).toMatch(/registerChatHandler\(ctx\)/);
    expect(handlers).not.toMatch(/registerChatHandler\(ctx\.db/);
  });

  it("the desktop-sync context exposes db as a live getter", () => {
    const handlers = fs.readFileSync(path.join(IPC_DIR, "handlers.ts"), "utf8");
    // registerSyncHandlers receives an object literal built in handlers.ts. A
    // plain `db: ctx.db` there is a snapshot; it must be a getter.
    expect(handlers).toMatch(/get db\(\)\s*\{\s*return ctx\.db;\s*\}/);
    expect(handlers).not.toMatch(/^\s*db: ctx\.db,\s*$/m);
  });

  it("the MCP notification poller resolves its DB + path lazily", () => {
    const poller = fs.readFileSync(
      path.resolve(IPC_DIR, "..", "lib", "mcp-poller.ts"),
      "utf8",
    );
    // A captured `dbPath` means the poller watches the abandoned workspace's WAL
    // forever after a swap, so MCP writes stop producing db:changed.
    expect(poller).toMatch(/getDb:\s*\(\)\s*=>\s*Database\.Database/);
    expect(poller).toMatch(/getDbPath:\s*\(\)\s*=>\s*string/);

    const main = fs.readFileSync(MAIN_TS, "utf8");
    expect(main).toMatch(/getDb:\s*\(\)\s*=>\s*ctx\.db/);
    expect(main).not.toMatch(/startMcpNotificationPoller\(\{\s*db: ctx\.db/);
  });

  it("reinitialise re-points the usage recorder's module-level handle", () => {
    const main = fs.readFileSync(MAIN_TS, "utf8");
    const start = main.indexOf("async function reinitialise(");
    expect(start, "reinitialise() not found in main.ts").toBeGreaterThan(-1);
    const body = main.slice(start, start + 3000);
    // usage-recorder keeps its own `activeDb` because recordLlmUsage is called
    // from deep inside the streaming loop with no ctx in scope. It is the one
    // handle reinitialise() must swap explicitly.
    expect(
      body,
      "reinitialise() must call initUsageRecorder(newDb) — otherwise the first " +
        "session's LLM cost/token rows are written to the abandoned DB.",
    ).toMatch(/initUsageRecorder\(newDb\)/);
  });
});
