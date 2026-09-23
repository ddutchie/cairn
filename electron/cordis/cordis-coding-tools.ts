/**
 * cordis-coding-tools — mount the dsh coding capability stack (bash / fs / search
 * / str-replace-editor / todo) plus the supporting sandbox + subprocess plugins
 * on a Cordis context, in the dsh-base order. This is the toolset the ported
 * coding agent (runCordisCodingLoop) drives, the Cordis equivalent of Cairn's
 * built-in coding-tools/*.
 *
 * Proven to mount + run on rc.8 in coding.live.test.ts. Kept as a single helper
 * so the loop and tests share one wiring definition and can't drift.
 *
 * Ordering matters (dsh-base):
 *   sandbox-local → sandbox-policy → fs-sandbox → fs-observation-policy →
 *   plan-mode → subprocess-local → bash-sandbox → shell-env →
 *   tool-bash → tool-fs → tool-fs-search → tool-str-replace-editor →
 *   tool-todo → agent-instructions
 *
 * bash-SANDBOX (not bash-local) is mounted so `workspace-write` and
 * `read-only` sessions are actually confined via `ctx.sandbox`. It falls
 * through to unconfined execution when the resolved mode is
 * `danger-full-access`, so this is a strict security upgrade — no behaviour
 * regression for the automation-dev / danger-full-access path.
 */
import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import * as fs from "node:fs";
import * as path from "node:path";

import sandboxLocalPlugin from "@deepseek-ai/dsh-sandbox-local";
import sandboxPolicyPlugin from "@deepseek-ai/dsh-sandbox-policy";
import fsSandboxPlugin from "@deepseek-ai/dsh-fs-sandbox";
import { apply as fsObsApply, name as fsObsName } from "@deepseek-ai/dsh-fs-observation-policy";
import { apply as toolBashApply, inject as toolBashInject, name as toolBashName } from "@deepseek-ai/dsh-tool-bash";
import { apply as toolFsApply, inject as toolFsInject, name as toolFsName } from "@deepseek-ai/dsh-tool-fs";
import { apply as toolFsSearchApply, inject as toolFsSearchInject, name as toolFsSearchName } from "@deepseek-ai/dsh-tool-fs-search";
import { apply as toolStrApply, inject as toolStrInject, name as toolStrName } from "@deepseek-ai/dsh-tool-str-replace-editor";
import { apply as toolTodoApply, inject as toolTodoInject, name as toolTodoName } from "@deepseek-ai/dsh-tool-todo";
import { apply as toolWorkflowApply, inject as toolWorkflowInject, name as toolWorkflowName } from "@deepseek-ai/dsh-tool-workflow";
import { apply as toolRalphApply, inject as toolRalphInject, name as toolRalphName } from "@deepseek-ai/dsh-tool-ralph";
import { apply as shellEnvApply, inject as shellEnvInject, name as shellEnvName } from "@deepseek-ai/dsh-shell-env";
import { apply as agentInstApply, name as agentInstName } from "@deepseek-ai/dsh-agent-instructions";
import subprocessLocalPlugin from "@deepseek-ai/dsh-subprocess-local";
import bashLocalPlugin from "@deepseek-ai/dsh-bash-local";
import bashSandboxPlugin from "@deepseek-ai/dsh-bash-sandbox";
import { apply as toolTerminalApply, inject as toolTerminalInject, name as toolTerminalName } from "@deepseek-ai/dsh-tool-terminal";
import { cairnTerminalBackendPlugin } from "./terminal-backend";
import type { Database } from "better-sqlite3";
import { mountCodingLsp } from "./cordis-lsp";
import { getBashExecutable } from "../lib/coding-tools/bash";

export interface CodingStackOptions {
  /** Working directory the coding tools are scoped to (the session cwd). */
  cwd: string;
  /**
   * Sandbox policy mode. Defaults to the safer "workspace-write" (fs/bash
   * confined to cwd) when a caller omits it — defense in depth. Production
   * always passes an explicit mode (see session-runtime-handlers / run-cordis-
   * coding), so this default only guards a future caller that forgets to.
   */
  sandboxMode?: "danger-full-access" | "workspace-write" | "read-only";
  /**
   * Session persona. "automation-dev" is a restricted persona for authoring
   * automation scripts: SKIP the bash + subprocess registration entirely so
   * the model cannot invoke shell commands (fs write is still allowed so it
   * can edit its scripts). Restores the pre-Cordis AUTOMATION_DEV_TOOLS
   * restriction — file tools only, no shell.
   */
  role?: "default" | "automation-dev";
  /**
   * Database handle for model-PTY cwd validation (project-boundary check in
   * the shared PTY manager). Optional so db-free harnesses (live mount
   * probes) can still mount the stack: without it the backend mounts but
   * every `terminal_open` fails closed. Production always passes `db`.
   */
  db?: Database;
}

/**
 * Mount the sandbox/fs ownership trio (sandbox-local → sandbox-policy →
 * fs-sandbox). These three register the "sandbox"/"sandboxPolicy"/"fs" service
 * NAMES, so at most ONE chain can exist per context lifetime.
 *
 * Adoption semantics: if one of the names is already registered (e.g. the chat
 * loop mounted an fs chain for plugins before the first coding turn), we log
 * and ADOPT the existing services instead of throwing — the per-turn mode/root
 * config is then ignored for the adopted parts (plan-mode tool gating still
 * enforced by cairnPlanModePlugin; noted tradeoff).
 */
async function plugFsChain(
  ctx: Context,
  opts: { cwd: string; mode: string },
  disposers: Array<() => void>,
  plug: (plugin: unknown, config?: unknown) => Promise<void>,
): Promise<void> {
  const owned: Array<[unknown, unknown]> = [
    [sandboxLocalPlugin, undefined],
    [sandboxPolicyPlugin, { mode: opts.mode, workspaceRoot: opts.cwd }],
    [fsSandboxPlugin, { cwd: opts.cwd }],
  ];
  for (const [plugin, config] of owned) {
    try {
      await plug(plugin, config);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/service ".+" has been registered/.test(msg)) {
        const existingMode = (ctx.get("sandboxPolicy") as { mode?: string } | undefined)?.mode ?? "unknown";
        console.warn(`[cordis-coding] adopting already-registered fs/sandbox service (${msg}); requested mode=${opts.mode} cwd=${opts.cwd} but existing mode=${existingMode} — per-turn sandbox config NOT applied (see P0-4)`);
        continue;
      }
      throw e;
    }
  }
  // Ensure artifact remap is applied even when adopting an existing fs chain.
  try { remapChatArtifactDirs(ctx); } catch { /* best-effort */ }
  // Pin the Windows sandbox runner (no-op off win32 / when already pinned).
  try { pinWindowsAclRunnerEntry(ctx); } catch { /* best-effort */ }
  // Pin the Linux Landlock launcher (no-op off Linux / when already pinned).
  try { pinLandlockLauncher(ctx); } catch { /* best-effort */ }
}

/** Mount ONLY the fs/sandbox ownership trio — used by the chat loop so plugin
 *  backends that inject "fs" can activate and execute outside coding turns.
 *  Kept alive for the process lifetime (never disposed): later coding turns
 *  ADOPT these services instead of re-registering (see plugFsChain).
 *
 *  Also remaps community-plugin artifact writes (`viz/…`, dsh-visualize) into
 *  `<workspace>/.chat/viz/…` so agent-generated files stay in ONE hidden dir
 *  instead of littering the project root — see artifact-hygiene.ts. */
export async function mountFsChain(ctx: Context, opts: { cwd: string; mode?: "workspace-write" | "read-only" | "danger-full-access" }): Promise<void> {
  if (ctx.get("fs")) {
    // Adopted — ensure remap even when chain already exists (coding may have mounted first without remap).
    remapChatArtifactDirs(ctx);
    return;
  }
  const disposers: Array<() => void> = [];
  const plug = async (plugin: unknown, config?: unknown): Promise<void> => {
    const fiber = ctx.plugin(plugin as never, config as never) as unknown as Promise<{ dispose: () => void }>;
    disposers.push(() => { fiber.then((f) => { try { f.dispose(); } catch { /* noop */ } }, () => {}); });
    await fiber;
  };
  await plugFsChain(ctx, { cwd: opts.cwd, mode: opts.mode ?? "workspace-write" }, disposers, plug);
  remapChatArtifactDirs(ctx);
}

/** Pin the Windows sandbox runner to the file shipped beside the bundle.
 *
 *  dsh-sandbox-local locates its Windows ACL runner via
 *  `import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner")` —
 *  which throws `import_meta2.resolve is not a function` in the esbuild CJS
 *  bundle (same family as the koffi `import.meta.dirname` breakage in #147),
 *  and would fail in the packaged app anyway (dsh packages are inlined, not
 *  shipped on disk). The provider honours `internals.windowsAclRunnerEntry`,
 *  so point it at `dist-electron/windows-acl-runner.cjs` (bundled standalone
 *  by scripts/compile-electron.js and shipped with the rest of dist-electron).
 *  No-op off win32 and when the file is
 *  absent (vitest runs source TS directly — nothing to pin). Idempotent. */
export function pinWindowsAclRunnerEntry(ctx: Context): void {
  if (process.platform !== "win32") return;
  const sandbox = ctx.get("sandbox") as { internals?: { windowsAclRunnerEntry?: string } } | undefined;
  if (!sandbox || typeof sandbox.internals !== "object" || sandbox.internals.windowsAclRunnerEntry) return;
  try {
    // At runtime this module is bundled into dist-electron/main.js, so the
    // runner ships alongside it. path.dirname(bundle) works in dev and in
    // the packaged app (resources/app/dist-electron).
    const entry = path.join(path.dirname(__filename), "windows-acl-runner.cjs");
    if (fs.existsSync(entry)) sandbox.internals.windowsAclRunnerEntry = entry;
  } catch { /* best-effort — the resolve() shim remains as fallback */ }
}

/** Pin the Linux Landlock launcher to the unpacked binary.
 *
 *  dsh-sandbox-local finds `landlock-run` in the per-platform
 *  `@deepseek-ai/node-addon-system-linux-<arch>` package relative to its own
 *  (bundled) module, and in the packaged app that path is inside app.asar,
 *  which `spawn` can't execute. The package ships unpacked
 *  (electron-builder.yml), so resolve it here and rewrite to
 *  app.asar.unpacked. No-op off Linux, when already pinned, or when the
 *  package is missing (dsh then reports the sandbox as unavailable). */
export function pinLandlockLauncher(ctx: Context): void {
  if (process.platform !== "linux") return;
  const sandbox = ctx.get("sandbox") as { internals?: { landlockLauncher?: string } } | undefined;
  if (!sandbox || typeof sandbox.internals !== "object" || sandbox.internals.landlockLauncher) return;
  try {
    const manifest = require.resolve(`@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/package.json`);
    sandbox.internals.landlockLauncher = path
      .join(path.dirname(manifest), "bin", "landlock-run")
      .replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  } catch { /* package not installed for this arch — leave dsh's default */ }
}

/** Run the pinned Windows sandbox runner as Node, not as a second Cairn.
 *
 *  dsh-sandbox-local spawns the runner as `[process.execPath, runner, …]`. In
 *  Electron that is Electron.exe, which without ELECTRON_RUN_AS_NODE boots the
 *  full app (single-instance handoff, GPU cache errors), so the command
 *  never runs and the tool output is Chromium's stderr. Instance-level patch
 *  on the `shell` executor's spawnSpec: add the variable only for that exact
 *  argv, so full-access `bash -c` spawns are untouched. The runner bundle
 *  removes it again before spawning the sandboxed command (banner in
 *  scripts/compile-electron.js). No-op off win32 / outside Electron. Idempotent. */
export function runWindowsAclRunnerAsNode(ctx: Context): void {
  if (process.platform !== "win32" || !process.versions.electron) return;
  const sandbox = ctx.get("sandbox") as { internals?: { windowsAclRunnerEntry?: string } } | undefined;
  const entry = sandbox?.internals?.windowsAclRunnerEntry;
  type SpawnSpec = { argv: string[]; env?: Record<string, string | undefined> };
  const shell = ctx.get("shell") as
    | { spawnSpec?: (...args: unknown[]) => SpawnSpec; __cairnRunnerAsNode?: boolean }
    | undefined;
  if (!entry || !shell || typeof shell.spawnSpec !== "function" || shell.__cairnRunnerAsNode) return;
  const origSpawnSpec = shell.spawnSpec.bind(shell);
  shell.spawnSpec = (...args: unknown[]) => {
    const spec = origSpawnSpec(...args);
    if (spec.argv[0] !== process.execPath || spec.argv[1] !== entry) return spec;
    return { ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: "1" } };
  };
  shell.__cairnRunnerAsNode = true;
}

/** Point sandboxed `bash -c` at Git Bash instead of the WSL launcher.
 *
 *  dsh-bash-sandbox confines a bare `["bash", "-c", cmd]`, and the Windows ACL
 *  runner hands that to CreateProcessAsUserW with no application name. The
 *  default search checks System32 BEFORE PATH, so any machine with WSL gets
 *  `C:\Windows\System32\bash.exe`. Under the restricted token that fails with
 *  `Bash/Service/CreateInstance/E_ACCESSDENIED` (printed as UTF-16). Full-access
 *  spawns resolve through PATH and are unaffected. Instance-level patch on
 *  `sandbox.confine`: rewrite argv[0] to the absolute Git Bash path (same
 *  resolver as automations). No-op off win32 / when Git Bash isn't found.
 *  Idempotent. */
export function pinWindowsSandboxBash(ctx: Context): void {
  if (process.platform !== "win32") return;
  const sandbox = ctx.get("sandbox") as
    | { confine?: (argv: string[], ...rest: unknown[]) => unknown; __cairnGitBash?: boolean }
    | undefined;
  if (!sandbox || typeof sandbox.confine !== "function" || sandbox.__cairnGitBash) return;
  const bash = getBashExecutable();
  if (!path.isAbsolute(bash)) return;
  const origConfine = sandbox.confine.bind(sandbox);
  sandbox.confine = (argv: string[], ...rest: unknown[]) =>
    origConfine(argv[0] === "bash" ? [bash, ...argv.slice(1)] : argv, ...rest);
  sandbox.__cairnGitBash = true;
}

/** Instance-level patch on the mounted fs service: rewrite the well-known
 *  plugin-artifact prefix `viz(/…)` to `.chat/viz(…)`. Only the chat-mounted
 *  chain is patched (coding mounts its own per-turn and stays stock). Harmless
 *  under adoption: nothing legitimate writes a top-level `viz/`. Idempotent. */export function remapChatArtifactDirs(ctx: Context): void {
  const fsSvc = ctx.get("fs") as
    | { resolve: (path: string, opts?: unknown) => Promise<unknown>; __cairnVizRemap?: boolean }
    | undefined;
  if (!fsSvc || typeof fsSvc.resolve !== "function" || fsSvc.__cairnVizRemap) return;
  const origResolve = fsSvc.resolve.bind(fsSvc);
  fsSvc.resolve = (path: string, opts?: unknown) =>
    origResolve(path === "viz" || path.startsWith("viz/") ? `.chat/${path}` : path, opts);
  fsSvc.__cairnVizRemap = true;
}

/**
 * Mount the coding capability stack on `ctx`. Returns a disposer that tears down
 * every mounted fiber in reverse order. Awaits each fiber so tool registration
 * is complete before returning.
 */
export async function mountCodingStack(ctx: Context, opts: CodingStackOptions): Promise<() => unknown> {
  const { cwd, sandboxMode = "workspace-write", role = "default", db } = opts;
  const disposers: Array<() => unknown> = [];
  const plug = async (plugin: unknown, config?: unknown): Promise<void> => {
    const name = (plugin as { name?: string })?.name ?? (plugin as { apply?: { name?: string } })?.apply?.name ?? "unknown";
    try {
      const fiber = ctx.plugin(plugin as never, config as never) as unknown as Promise<{ dispose: () => unknown }>;
      // Return the teardown chain so the turn-end disposeAsync awaits fiber
      // unload — otherwise the next turn's same-name tool registrations race
      // the previous turn's still-unloading fibers ("already registered").
      disposers.push(() => fiber.then((f) => f.dispose(), () => {}));
      await fiber;
    } catch (e) {
      console.error(`[cordis-coding] plug ${String(name)} failed:`, (e as Error)?.message ?? e, (e as Error)?.stack ?? "");
      throw e;
    }
  };

  await plugFsChain(ctx, { cwd, mode: sandboxMode }, disposers, plug);
  await plug({ apply: fsObsApply, name: fsObsName });
  // plan-mode is mounted GLOBALLY in getContext (dsh owns it; /plan command +
  // plan:policy section) — plugging it here too would duplicate the section.

  // Bash executor + tool-bash: SKIP for the automation-dev persona. That
  // session's persona is "author scripts only" — the pre-Cordis loop enforced
  // this by omitting bash from AUTOMATION_DEV_TOOLS. Without the persona
  // restriction, an automation-dev session would silently gain a fully-
  // privileged shell (see review finding H3). fs / str_replace_editor /
  // tool-fs / tool-fs-search stay mounted so the persona can still read +
  // edit its script files.
  if (role !== "automation-dev") {
    await plug(subprocessLocalPlugin);
    // Bash executor: bash-SANDBOX (not bash-local) so `workspace-write` /
    // `read-only` sessions are actually confined via `ctx.sandbox` (Seatbelt on
    // macOS, Landlock on Linux, ACL restricted-token on Windows). `bash-sandbox`
    // extends `LocalBashExecutor` and passes through unchanged when the resolved
    // mode is `danger-full-access`, so this is a strict security upgrade —
    // dangerous-mode sessions behave exactly as before, sandboxed modes get real
    // enforcement. Peers (dsh-shell, dsh-sandbox, dsh-invariants,
    // dsh-sandbox-policy, dsh-bash-local) are all already mounted or declared.
    // NOTE: `bashLocalPlugin` remains imported only so the type import chain
    // survives — the mount is now unreachable and can be removed once we're
    // confident the sandbox path is stable across all supported platforms.
    void bashLocalPlugin;
    await plug(bashSandboxPlugin);
    try { runWindowsAclRunnerAsNode(ctx); } catch { /* best-effort */ }
    try { pinWindowsSandboxBash(ctx); } catch { /* best-effort */ }
    await plug({ apply: shellEnvApply, inject: shellEnvInject as never, name: shellEnvName }, {});
    await plug({ apply: toolBashApply, inject: toolBashInject as never, name: toolBashName }, {});
    // Persistent model shells over the shared node-pty manager (same login
    // shells + project-boundary validation as the bottom-terminal tabs — no
    // second PTY implementation). Coding turns only: the automation-dev
    // persona gets no shell of any kind (this whole block is skipped), and
    // chat turns never mount this stack. Backend first (registers type
    // "shell"), then the six model tools
    // (terminal_open/send/read/signal/close/list). Background sends
    // (`run_in_background`) register `pty-send` jobs on the global jobs
    // registry, which the existing jobs bridge already projects to the dock
    // as kind:"jobs" — zero new UI.
    await plug(cairnTerminalBackendPlugin, { cwd, ...(db !== undefined ? { db } : {}) });
    await plug(
      { apply: toolTerminalApply, inject: toolTerminalInject as never, name: toolTerminalName },
      { enableRunInBackground: true },
    );
  } else {
    // Keep the reference so eslint no-unused-vars doesn't fire; the linter
    // can't see conditionally-skipped imports.
    void subprocessLocalPlugin;
    void bashSandboxPlugin;
    void bashLocalPlugin;
    void shellEnvApply; void shellEnvInject; void shellEnvName;
    void toolBashApply; void toolBashInject; void toolBashName;
  }
  // First-party LSP code navigation (dsh-lsp seam + stdio provider +
  // model tool — READ-ONLY ops only). Fail-soft: without a language-server
  // binary on PATH (or under the automation-dev persona, which has no
  // subprocess service) this mounts nothing and the turn proceeds with
  // grep/read as before. See cordis-lsp.ts for the lifecycle decision.
  // mountCodingLsp never throws (it warns and reports { mounted: false }),
  // so no try/catch is needed here — a coding turn must not depend on it.
  await mountCodingLsp(ctx, plug);
  await plug(
    { apply: toolFsApply, inject: toolFsInject as never, name: toolFsName },
    { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 10485760 },
  );
  await plug(
    { apply: toolFsSearchApply, inject: toolFsSearchInject as never, name: toolFsSearchName },
    // Search results are still bounded inline by globMaxResults/grepMaxMatches,
    // but the raw rg stream must be large enough to parse a broad repository
    // before those caps can be applied.
    { globMaxResults: 1000, grepMaxMatches: 500, grepMaxLineBytes: 4096, searchMetaMaxBytes: 10000, rawOutputMaxBytes: 2_000_000, graceMs: 100, stderrMaxBytes: 10000, timeoutMs: 30000, sampleOverCapGlobResults: false },
  );
  await plug({ apply: toolStrApply, inject: toolStrInject as never, name: toolStrName }, { maxOutputChars: 16000 });
  await plug({ apply: toolTodoApply, inject: toolTodoInject as never, name: toolTodoName }, { allowParallelInProgress: true });
  // Workflow + Ralph model tools (dsh-workflow / dsh-tool-workflow /
  // dsh-tool-ralph over the ENTRY_LIST-mounted worker-thread engine above).
  // Coding turns only: both fan out `spawn`-provider children that inherit
  // the coding tool stack, and both inject only global services
  // (tools/workflowEngine/subagents/systemPrompt), so per-turn plug/dispose
  // matches the bash/fs/todo lifecycle exactly.
  //
  // Heartbeat relationship (NOT a replacement — do not touch
  // electron/lib/heartbeat-*): heartbeat is a single headless turn per
  // automation tick (poll → act → settle); workflows/ralph are foreground
  // fan-out orchestration INSIDE a live turn (one model call coordinating
  // many subagents toward a bounded result). Complementary axes:
  // automation cadence vs in-turn parallelism. An automation script COULD
  // invoke them via the coding loop, but nothing here changes what heartbeat
  // schedules or how it settles.
  //
  // Bounds (no double-runaway — pinned in workflow-ralph.test.ts): ralph
  // caps rounds at maxRounds (default 256, model-requestable only downward);
  // the engine caps total children at maxTotalAgents (default 1000, ditto).
  // Explicit full configs: the B-map-style triplet carries no Config schema,
  // so raw ctx.plugin cannot default them.
  await plug(
    { apply: toolWorkflowApply, inject: toolWorkflowInject as never, name: toolWorkflowName },
    { toolName: "workflow", maxResultChars: 50_000 },
  );
  await plug(
    { apply: toolRalphApply, inject: toolRalphInject as never, name: toolRalphName },
    { subagentProvider: "spawn", maxRounds: 256, maxHandoffChars: 16_384, maxResultChars: 16_384 },
  );
  await plug({ apply: agentInstApply, name: agentInstName }, { maxBytes: 65536, maxSourceBytes: 500000 });

  return async () => {
    for (const d of disposers.reverse()) {
      try { await d(); } catch { /* noop */ }
    }
  };
}
