/**
 * hooks-bridge — adopt the dsh hook packages as the backend for running
 * unmodified Claude Code / Codex command hooks on dsh interception seams, so
 * community plugins interoperate with those ecosystems (per
 * docs/dsh-product-decisions.md). Cairn exposes NO new Settings/UI surface for
 * this: hooks are file-configured, opt-in, and DISABLED by default.
 *
 * ── Config surface (file format + location) ────────────────────────────────
 * User-level, one file per dialect (drop-in compatible with the native files —
 * a user can copy/symlink their existing hooks.json):
 *
 *   ~/.config/cairn/hooks/claude-code.json
 *     Claude Code hooks.json shape, OR a settings file whose `hooks` key holds
 *     it. Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 *     Stop, SubagentStart, SubagentStop. Only `{ type: "command", command,
 *     timeout? }` hooks run (`timeout` in SECONDS); `prompt`/`agent`/`http`
 *     types are parsed-and-skipped with a warning. `${CLAUDE_PLUGIN_ROOT}` /
 *     `${CLAUDE_PROJECT_DIR}` substitution applies at parse time; the hook
 *     process additionally gets `CLAUDE_PROJECT_DIR` in its env (explicit
 *     config value wins, else the session workspace) and runs with cwd = the
 *     agent's session workspace.
 *
 *   ~/.config/cairn/hooks/codex.json
 *     Codex hooks.json shape (`{ hooks: { … } }` wrapper or the bare event
 *     map). Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 *     Stop. Only synchronous command hooks run; other types and
 *     `async: true` hooks are skipped with a warning. No command substitution,
 *     no hook env; payloads are snake_case without a trailing newline.
 *
 * Absent file → that dialect is NOT mounted. Both absent → NOTHING is mounted
 * (zero listeners, zero behavior change). A present-but-unparseable file logs
 * a warning and registers nothing (upstream fail-soft). Per-hook timeouts
 * default to 600s (upstream `DEFAULT_HOOK_TIMEOUT_MS`); stderr summaries
 * persisted to `hook/result` events cap at 500 chars.
 *
 * ── What "run hooks on dsh interception seams" means concretely ────────────
 * Each bridge subscribes to dsh waterfall/emit events on the mounted context
 * and folds matched hooks (most-restrictive merge: deny > ask > allow) onto
 * the seam decision:
 *
 *   agent/session-start  → SessionStart   (detached; context injected late)
 *   agent/pre-step       → UserPromptSubmit (matcherless; deny ⇒ reject step)
 *   tools/pre-execute    → PreToolUse     (matcher = tool name;
 *                                          deny ⇒ deny, ask ⇒ ask — this composes
 *                                          with cairnApprovalPlugin, which sees
 *                                          the same waterfall)
 *   tools/post-execute   → PostToolUse    (matcher = tool name; deny ⇒ block)
 *   agent/turn-stopping  → Stop           (matcherless; deny ⇒ steer to continue)
 *   subagent/start|end   → SubagentStart|Stop (Claude bridge only; detached)
 *
 * Hook processes run through `ctx.shell` — in Cairn that is the sandboxed
 * coding-stack shell, so hooks inherit the session's sandbox confinement
 * (workspace-write/read-only) rather than gaining a free shell. `updatedInput`
 * rewrites are parsed but NOT honored (logged + warned, upstream limitation);
 * `systemMessage` output is likewise logged, not surfaced.
 *
 * ── Mounting ───────────────────────────────────────────────────────────────
 * Post-bootstrap via `ctx.plugin` (like PermissionPresetService), NOT an
 * ENTRY_LIST entry: both bridges inject `shell` + `sessionProjections`, and
 * `shell` is only mounted per-turn by the coding stack — as loader entries
 * they would stall `loader.await()` forever at bootstrap. Mounted ONCE on the
 * shared context; fibers pend until the first coding turn mounts `shell`,
 * then activate. Chat turns mount no `shell`, so hooks stay dormant there
 * (scope: coding sessions only — a turn without a shell cannot run a hook).
 * Static dsh imports so a missing/broken package fails loudly at bundle time.
 */

import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import {
  apply as claudeCodeApply,
  inject as claudeCodeInject,
  name as claudeCodeName,
} from "@deepseek-ai/dsh-hooks-claude-code";
import {
  apply as codexApply,
  inject as codexInject,
  name as codexName,
} from "@deepseek-ai/dsh-hooks-codex";

/** Resolved hook config: absolute config file per dialect (absent = disabled). */
export interface HooksResolution {
  claudeCode?: string;
  codex?: string;
}

type Log = (msg: string) => void;

/**
 * Mount the configured hook dialects on `ctx` (fire-and-forget fibers: the
 * bridges activate once `shell` appears; nothing to await at mount time).
 * Returns one dispose thunk per mounted dialect; returns [] when nothing is
 * configured. Never throws into the caller — mount failures log.
 */
export function mountCairnHooks(
  ctx: Context,
  resolved: HooksResolution,
  opts: { log?: Log } = {},
): Array<() => unknown> {
  const log = opts.log ?? ((msg: string) => console.warn(`[hooks] ${msg}`));
  const disposers: Array<() => unknown> = [];
  const plug = ctx.plugin as unknown as (
    p: { apply: (...args: never[]) => unknown; inject: readonly string[]; name: string },
    c: { configPath: string },
  ) => Promise<{ dispose: () => unknown }>;

  const mountOne = (
    label: string,
    plugin: { apply: (...args: never[]) => unknown; inject: readonly string[]; name: string },
    configPath: string | undefined,
  ): void => {
    if (!configPath) return;
    try {
      const fiber = plug(plugin, { configPath });
      // An unawaited fiber must never surface an unhandled rejection (e.g. a
      // future validation throw inside apply). The bridges themselves fail
      // soft on bad config files (warn + register nothing).
      fiber.catch((e) => log(`${label} mount failed: ${(e as Error)?.message ?? String(e)}`));
      disposers.push(() => fiber.then(
        (f) => (f as { dispose: () => unknown }).dispose(),
        () => {},
      ));
    } catch (e) {
      log(`${label} mount failed: ${(e as Error)?.message ?? String(e)}`);
    }
  };

  mountOne(
    "hooks-claude-code",
    { apply: claudeCodeApply as (...args: never[]) => unknown, inject: claudeCodeInject as readonly string[], name: claudeCodeName },
    resolved.claudeCode,
  );
  mountOne(
    "hooks-codex",
    { apply: codexApply as (...args: never[]) => unknown, inject: codexInject as readonly string[], name: codexName },
    resolved.codex,
  );
  return disposers;
}
