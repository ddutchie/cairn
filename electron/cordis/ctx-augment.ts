/**
 * Cairn — TypeScript augmentation of `@deepseek-ai/cordis` Context.
 *
 * dsh services (dsh-session, dsh-user-approval, dsh-plan-mode, dsh-commands,
 * dsh-skill, dsh-token-meter, dsh-session-projection, ...) each augment
 * `Context` with their own service field via
 * `declare module '@deepseek-ai/cordis' { interface Context { ... } }`.
 * That mechanism relies on the augmenting module being imported somewhere
 * in the compilation — normally each service's value import already
 * satisfies it. This module collects Cairn's OWN additions to that same
 * interface (`ctx.cairn`, our plugin-facing seam) and re-exports the dsh
 * augmentations via side-effect imports so a caller who needs the fully-
 * augmented Context type has one thing to import.
 *
 * Before this file, Cairn code cast around the augmented shape at every
 * touch site (~50 `(ctx as unknown as {...}).sessions?.get?.(id)` etc.),
 * which meant an upstream signature change was a runtime regression, not
 * a compile error. That inverted the branch's whole point (track dsh
 * cheaply). Importing this module OR any of the dsh service packages a
 * file already uses is enough to make the boundary type-safe.
 */

// Ambient re-export of every dsh service augmentation Cairn depends on.
// Value-side imports elsewhere in the codebase already load these modules;
// this file just makes the augmentations reachable from every consumer
// even if they only import types.
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-user-approval";
import "@deepseek-ai/dsh-user-questions";
import "@deepseek-ai/dsh-plan-mode";
import "@deepseek-ai/dsh-commands";
import "@deepseek-ai/dsh-skill";
import "@deepseek-ai/dsh-token-meter";
import "@deepseek-ai/dsh-compaction-tool-result-pruner";
import "@deepseek-ai/dsh-session-projection";
import "@deepseek-ai/dsh-session-title";
import "@deepseek-ai/dsh-session-title-first-prompt-llm";
import "@deepseek-ai/dsh-compaction";
import "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-agent-loop";
import "@deepseek-ai/dsh-attachment";
import "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-session-persistence";
import "@deepseek-ai/dsh-terminal";
import "@deepseek-ai/dsh-goal";
import "@deepseek-ai/dsh-tool-goal";
import "@deepseek-ai/dsh-command-goal";
import "@deepseek-ai/dsh-goal-round-driver";
import "@deepseek-ai/dsh-message-feedback";
import "@deepseek-ai/dsh-command-feedback";
import "@deepseek-ai/dsh-lsp";
import "@deepseek-ai/cordis-plugin-loader";

// Ensure the augmentation-only imports aren't tree-shaken. TypeScript's
// isolated modules mode treats bare side-effect imports as needed, but a
// downstream bundler could see this file as empty; a re-export keeps it
// live in the output.
export type Context = import("@deepseek-ai/cordis").Context;

/**
 * The Cairn-owned surface on `ctx.cairn`. Third-party plugins consume this;
 * changing shape here is a wire-level contract change and must be handled
 * carefully.
 *   - `defineTool` — bridge into `ctx.tools.register` for plugin authors.
 *   - `confirm` — host-mediated confirmation seam (plugins call this to
 *     ask the user before doing something risky; the transport routes to
 *     the interactive approval card in the running Electron shell, and to
 *     a headless allow/deny in an automation run). See
 *     `electron/cordis/approval-transports.ts`.
 */
export interface CairnHostContext {
  /** Register a Cairn-shaped tool onto `ctx.tools`. Same schema DSL as dsh. */
  defineTool: unknown;
  /**
   * Ask the host to confirm a plugin-mediated action. Resolves to one of:
   *   - "allowed-once"  — user approved this call only
   *   - "rejected"      — user denied
   *   - "cancelled"     — the ask expired / the turn aborted / no transport
   *
   * Kept structurally-typed rather than importing dsh types here, so third-
   * party plugins in a separate build (with their own dsh-tools resolution)
   * still satisfy the shape without a compile mismatch.
   */
  confirm: (
    sessionId: string,
    req: { title?: string; detail?: string; toolName?: string; args?: Record<string, unknown> },
    opts?: { signal?: AbortSignal },
  ) => Promise<"allowed-once" | "rejected" | "cancelled">;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /**
     * Cairn's plugin-facing seam. Populated by run-cordis-loop.ts's
     * getContext() once the shared context is built; undefined during
     * boot before that assignment lands.
     */
    cairn?: CairnHostContext;
  }
}
