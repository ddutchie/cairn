/**
 * cairn-plugins — Cairn's own Cordis plugins (the parity layer).
 *
 * Each plugin mounts on the shared Cordis tree and maps a dsh concern onto
 * Cairn's existing persistence + usage surfaces, so Cairn's renderer, mobile
 * bridge, and Usage view work unchanged over the dsh agent loop.
 *
 *  - cairnDbPlugin   — owns the Database handle + HostStore on the context
 *                      (`CAIRN_DB` / `CAIRN_HOST`). The single ABI-safe way
 *                      Cairn plugins touch SQLite (see `./host-store.ts`).
 *  - cairnSessionPlugin — subscribe to `session/event` and persist messages to
 *                      `chat_threads` / `chat_messages`.
 *  - cairnUsagePlugin  — on usage chunks, record via the HostStore seam (Usage view).
 *
 * Plus cairnSystemPromptPlugin, cairnSubagentPlugin, cairnQuestionsPlugin,
 * cairnCodingPlugin and cairnApprovalPlugin. Each lives in `./plugins/`; this
 * module re-exports them so callers import from one place.
 *
 * These are pure persistence plugins; live IPC streaming stays in the session
 * runner's drain so the renderer gets realtime
 * deltas while the DB gets the durable record.
 */
export { CAIRN_DB, CAIRN_HOST } from "./host-store";
export type { HostStore } from "./host-store";
export * from "./plugins/system-prompt";
export { cairnDbPlugin, type CairnDbConfig } from "./plugins/db";
export * from "./plugins/session";
export * from "./plugins/subagent";
export * from "./plugins/questions";
export * from "./plugins/usage";
export * from "./plugins/coding";
export * from "./plugins/approval";
