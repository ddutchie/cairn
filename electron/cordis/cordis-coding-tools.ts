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
 *   plan-mode → subprocess-local → bash-local → shell-env →
 *   tool-bash → tool-fs → tool-fs-search → tool-str-replace-editor →
 *   tool-todo → agent-instructions
 */
import type { Context } from "@deepseek-ai/cordis";

import planModePlugin from "@deepseek-ai/dsh-plan-mode";
import sandboxLocalPlugin from "@deepseek-ai/dsh-sandbox-local";
import sandboxPolicyPlugin from "@deepseek-ai/dsh-sandbox-policy";
import fsSandboxPlugin from "@deepseek-ai/dsh-fs-sandbox";
import { apply as fsObsApply, name as fsObsName } from "@deepseek-ai/dsh-fs-observation-policy";
import { apply as toolBashApply, inject as toolBashInject, name as toolBashName } from "@deepseek-ai/dsh-tool-bash";
import { apply as toolFsApply, inject as toolFsInject, name as toolFsName } from "@deepseek-ai/dsh-tool-fs";
import { apply as toolFsSearchApply, inject as toolFsSearchInject, name as toolFsSearchName } from "@deepseek-ai/dsh-tool-fs-search";
import { apply as toolStrApply, inject as toolStrInject, name as toolStrName } from "@deepseek-ai/dsh-tool-str-replace-editor";
import { apply as toolTodoApply, inject as toolTodoInject, name as toolTodoName } from "@deepseek-ai/dsh-tool-todo";
import { apply as shellEnvApply, inject as shellEnvInject, name as shellEnvName } from "@deepseek-ai/dsh-shell-env";
import { apply as agentInstApply, name as agentInstName } from "@deepseek-ai/dsh-agent-instructions";
import subprocessLocalPlugin from "@deepseek-ai/dsh-subprocess-local";
import bashLocalPlugin from "@deepseek-ai/dsh-bash-local";

export interface CodingStackOptions {
  /** Working directory the coding tools are scoped to (the session cwd). */
  cwd: string;
  /**
   * Sandbox policy mode. "danger-full-access" mirrors Cairn's current coding
   * agent (unsandboxed fs/bash within cwd); a tighter preset can be swapped in
   * once the approval layer lands (Phase 1.5 step 2e/2j).
   */
  sandboxMode?: "danger-full-access" | "workspace-write" | "read-only";
  /** Plan-mode guidance section (non-empty — dsh rejects an empty section). */
  planModeSection?: string;
}

const DEFAULT_PLAN_SECTION =
  "You are in plan mode. Stay in plan mode until the user switches the session mode. Explore and read first; do not edit files or run mutating commands.";

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
        console.warn(`[cordis-coding] adopting already-registered fs/sandbox service (${msg}); per-turn sandbox config not applied`);
        continue;
      }
      throw e;
    }
  }
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
  if ((ctx as unknown as { get: (n: string) => unknown }).get("fs")) return;
  const disposers: Array<() => void> = [];
  const plug = async (plugin: unknown, config?: unknown): Promise<void> => {
    const fiber = (ctx as unknown as { plugin: (p: unknown, c?: unknown) => Promise<{ dispose: () => void }> }).plugin(plugin, config);
    disposers.push(() => { fiber.then((f) => { try { f.dispose(); } catch { /* noop */ } }, () => {}); });
    await fiber;
  };
  await plugFsChain(ctx, { cwd: opts.cwd, mode: opts.mode ?? "workspace-write" }, disposers, plug);
  remapChatArtifactDirs(ctx);
}

/** Instance-level patch on the mounted fs service: rewrite the well-known
 *  plugin-artifact prefix `viz(/…)` to `.chat/viz(…)`. Only the chat-mounted
 *  chain is patched (coding mounts its own per-turn and stays stock). Harmless
 *  under adoption: nothing legitimate writes a top-level `viz/`. Idempotent. */
export function remapChatArtifactDirs(ctx: Context): void {
  const fsSvc = (ctx as unknown as { get: (n: string) => unknown }).get("fs") as
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
export async function mountCodingStack(ctx: Context, opts: CodingStackOptions): Promise<() => void> {
  const { cwd, sandboxMode = "danger-full-access", planModeSection = DEFAULT_PLAN_SECTION } = opts;
  const disposers: Array<() => void> = [];
  const plug = async (plugin: unknown, config?: unknown): Promise<void> => {
    const name = (plugin as { name?: string })?.name ?? (plugin as { apply?: { name?: string } })?.apply?.name ?? "unknown";
    try {
      const fiber = (ctx as unknown as { plugin: (p: unknown, c?: unknown) => Promise<{ dispose: () => void }> }).plugin(plugin, config);
      disposers.push(() => { fiber.then((f) => { try { f.dispose(); } catch { /* noop */ } }, () => {}); });
      await fiber;
    } catch (e) {
      console.error(`[cordis-coding] plug ${String(name)} failed:`, (e as Error)?.message ?? e, (e as Error)?.stack ?? "");
      throw e;
    }
  };

  await plugFsChain(ctx, { cwd, mode: sandboxMode }, disposers, plug);
  await plug({ apply: fsObsApply, name: fsObsName });
  await plug(planModePlugin, { section: planModeSection });
  await plug(subprocessLocalPlugin);
  await plug(bashLocalPlugin);
  await plug({ apply: shellEnvApply, inject: shellEnvInject as never, name: shellEnvName }, {});
  await plug({ apply: toolBashApply, inject: toolBashInject as never, name: toolBashName }, {});
  await plug(
    { apply: toolFsApply, inject: toolFsInject as never, name: toolFsName },
    { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 10485760 },
  );
  await plug(
    { apply: toolFsSearchApply, inject: toolFsSearchInject as never, name: toolFsSearchName },
    { globMaxResults: 1000, grepMaxMatches: 500, grepMaxLineBytes: 4096, searchMetaMaxBytes: 10000, rawOutputMaxBytes: 100000, graceMs: 100, stderrMaxBytes: 10000, timeoutMs: 30000, sampleOverCapGlobResults: false },
  );
  await plug({ apply: toolStrApply, inject: toolStrInject as never, name: toolStrName }, { maxOutputChars: 16000 });
  await plug({ apply: toolTodoApply, inject: toolTodoInject as never, name: toolTodoName }, { allowParallelInProgress: true });
  await plug({ apply: agentInstApply, name: agentInstName }, { maxBytes: 65536, maxSourceBytes: 500000 });

  return () => { for (const d of disposers.reverse()) { try { d(); } catch { /* noop */ } } };
}
