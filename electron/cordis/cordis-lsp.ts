/**
 * cordis-lsp — first-party LSP code navigation for the CODING stack only.
 *
 * Mounts the dsh LSP triple on a per-turn coding context, in dependency
 * order:
 *
 *   1. `Lsp` seam service (`ctx.lsp` — provider registry + normalized
 *      goToDefinition/findReferences/goToImplementation/hover; no inject, so
 *      ENTRY_LIST-safe in principle, but mounted here per-turn so the chat
 *      loop never sees `ctx.lsp` at all).
 *   2. `dsh-lsp-stdio` (generic stdio language-server provider; injects
 *      `fs` + `lsp` + `subprocess` — `fs`/`subprocess` are per-turn coding
 *      services, so like PermissionPresetService — which injects per-turn
 *      `shell` — this is a post-bootstrap mount, NOT an ENTRY_LIST entry).
 *   3. `dsh-tool-lsp` (the model-facing `lsp` tool; injects `tools` + `lsp` +
 *      `systemPrompt`; read-only ops only — definition/references/hover/
 *      implementation, no workspace edits, no execute).
 *
 * The chat loop mounts only `mountFsChain` (see chat-session-runner.ts /
 * run-cordis-loop.ts) and never calls this module, so the `lsp` tool is
 * coding-only by construction.
 *
 * LIFECYCLE DECISION (v1, minimal and explicit):
 * - Language servers are external binaries. v1 does PATH auto-detect for
 *   exactly one server — `typescript-language-server --stdio` (covers
 *   TypeScript + JavaScript; the extension→languageId map below mirrors
 *   dsh's own typescript-server.e2e.ts) — and mounts nothing when it is
 *   absent. No bundling (native/platform implications, out of scope), no
 *   silent install (no network at runtime), no hang: a missing binary is a
 *   warn log + no `lsp` tool that turn, and the model falls back to
 *   grep/read as before.
 * - Out of the box: `.ts/.tsx/.mts/.cts` (typescript/typescriptreact) and
 *   `.js/.jsx/.mjs/.cjs` (javascript/javascriptreact) — iff
 *   `typescript-language-server` resolves on the (scrubbed) PATH. Every
 *   other language fails closed with `LSP_UNAVAILABLE` ("no LSP provider
 *   handles ...") — a clear tool error, never a hung turn. The tool itself
 *   carries a 60s budget (dsh default) enforced by the timeout policy.
 * - Server processes spawn lazily on the first matching query with cwd =
 *   the canonical session workspace, and are torn down with the turn (the
 *   coding stack's reverse-order disposers reach quiescence via lsp-stdio's
 *   shutdown→exit→SIGTERM→SIGKILL ladder).
 *
 * PROSPECTIVE user-config format (NOT read today — documented so a future
 * settings surface has a contract to implement; v1 is PATH auto-detect):
 * ```jsonc
 * // ~/.config/cairn/lsp.json
 * {
 *   "servers": {
 *     "<providerId>": {
 *       "command": "typescript-language-server", // absolute or PATH-resolved at load
 *       "args": ["--stdio"],                    // no shell
 *       "extensionToLanguage": { ".ts": "typescript" },
 *       "env": {}                               // merged over the scrubbed ambient env
 *     }
 *   }
 * }
 * ```
 * Adding it means threading a `servers` table through the existing
 * coding/agent settings plumbing (host-store + config-cache agentConfig) —
 * deliberately deferred: the plumbing read is startup-cached while servers
 * resolve per-turn, so it is not trivially local.
 */
import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import LspService from "@deepseek-ai/dsh-lsp";
import * as LspStdio from "@deepseek-ai/dsh-lsp-stdio";
import * as ToolLsp from "@deepseek-ai/dsh-tool-lsp";

/** Bare command probed on the scrubbed PATH; args passed with no shell. */
export const LSP_TS_COMMAND = "typescript-language-server";
export const LSP_TS_ARGS: readonly string[] = ["--stdio"];

/**
 * v1 extension map for the TypeScript server. `.tsx` → `typescriptreact`
 * (and `.jsx` → `javascriptreact`) mirror dsh's own e2e; without the react
 * ids the server rejects the didOpen for those files.
 */
export const LSP_TS_EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

/** Provider id reserved on `ctx.lsp` for the v1 TypeScript server. */
export const LSP_TS_PROVIDER_ID = "typescript";

/** Plug helper shape (matches the local `plug` in mountCodingStack). */
export type CodingPlug = (plugin: unknown, config?: unknown) => Promise<void>;

export interface CodingLspMountResult {
  /** True when the seam + provider + tool all mounted. */
  mounted: boolean;
  /** Machine-readable reason (`mounted`, `no-subprocess`, `server-not-found`, `already-registered`, `mount-failed`). */
  reason: string;
}

/**
 * Mount the LSP triple for one coding turn. Fail-SOFT by design: LSP is an
 * additive precision aid, so any failure (no subprocess service, no server
 * binary on PATH, late plug error) is a warn log + `{ mounted: false }` —
 * never a thrown turn failure. Call only after the fs chain + subprocess
 * service are mounted (the stdio provider injects both).
 */
export async function mountCodingLsp(ctx: Context, plug: CodingPlug): Promise<CodingLspMountResult> {
  // automation-dev persona skips subprocess registration entirely, and the
  // stdio provider cannot activate without it — skip before touching the seam
  // so no half-mounted state is possible.
  const subprocess = (ctx as unknown as { get?: (name: string) => unknown }).get?.("subprocess");
  if (!subprocess) {
    return { mounted: false, reason: "no-subprocess" };
  }
  if ((ctx as unknown as { get?: (name: string) => unknown }).get?.("lsp")) {
    console.warn("[cordis-lsp] ctx.lsp already registered — skipping LSP mount for this turn (previous turn teardown pending?)");
    return { mounted: false, reason: "already-registered" };
  }
  try {
    // PATH probe in the exact execution world the server would spawn in
    // (scrubbed env, no spawn — stat/access only, bounded). A miss means the
    // user has no language server: mount nothing so the model keeps the
    // grep/read workflow with zero prompt bloat from a tool that always errors.
    const subprocessSvc = subprocess as {
      resolveExecutable: (command: string, env?: Record<string, string>, signal?: AbortSignal) => Promise<string>;
    };
    try {
      await subprocessSvc.resolveExecutable(LSP_TS_COMMAND, {});
    } catch (e) {
      console.warn(`[cordis-lsp] ${LSP_TS_COMMAND} not found on PATH — LSP code navigation disabled for this turn (${(e as Error)?.message ?? e})`);
      return { mounted: false, reason: "server-not-found" };
    }
    await plug(LspService);
    // Mount the FULL plugin namespaces (not stripped {apply,inject,name}
    // triples): Cordis applies each plugin's schemastery `Config` schema on
    // this path, filling every default (lsp-stdio REJECTS undefined timer/
    // byte caps at load — a stripped triple would throw even for a valid
    // server table). This mirrors how dsh's own tests mount these plugins.
    await plug(LspStdio, {
      servers: {
        [LSP_TS_PROVIDER_ID]: {
          command: LSP_TS_COMMAND,
          args: [...LSP_TS_ARGS],
          extensionToLanguage: { ...LSP_TS_EXTENSION_TO_LANGUAGE },
        },
      },
    });
    await plug(ToolLsp, {});
    return { mounted: true, reason: "mounted" };
  } catch (e) {
    // Fail-soft: a TOCTOU binary removal or any other late plug error must
    // not break the coding turn. The seam may be left providerless — without
    // the tool mounted no model call can reach it.
    console.warn("[cordis-lsp] LSP mount failed — continuing without code navigation:", (e as Error)?.message ?? e);
    return { mounted: false, reason: "mount-failed" };
  }
}
