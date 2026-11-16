/**
 * Shared tool-name predicates — the single home for "what kind of tool is
 * this called?" by name alone (F3 stage 1, plan §C2).
 *
 * Four copies of the read-tool prefix test, three of the external-tool test
 * and two of the code-exec set drifted across `electron/lib/` and `src/`.
 * Import from here instead of re-writing them.
 *
 * Pure data + pure functions: no Electron, no Node APIs — importable from
 * the renderer, the main process, and unit tests unchanged.
 */

/** Read-only Cairn/data tool prefixes: `get_*`, `list_*`, `search_*`. */
const CAIRN_READ_PREFIXES: readonly string[] = ["get_", "list_", "search_"];

/**
 * True for read-only tool names — never gated by the automation approval
 * policy and labelled "read" by the tool inventory / MCP listing.
 *
 * `codebase_query` is read-only (READ in `shared/agent/tool-risk.ts`) but
 * matches no prefix, so it is named explicitly.
 */
export function isCairnReadTool(name: string): boolean {
  if (name === "codebase_query") return true;
  return CAIRN_READ_PREFIXES.some((p) => name.startsWith(p));
}

/** MCP server (`mcp__…`) and custom-service (`svc__…`) prefix. */
const EXTERNAL_TOOL_PREFIXES: readonly string[] = ["mcp__", "svc__"];

/**
 * True for external-tool names (namespaced MCP `mcp__…` / service `svc__…`
 * calls). Equivalent to `isMcpToolName || isServiceToolName`
 * (`shared/chat/mcp-namespace.ts`, `shared/chat/service-exec.ts`) and to the
 * `executeExternalTool` routing in `electron/lib/external-tools.ts`, which
 * dispatches on the same namespace prefixes.
 */
export function isExternalToolName(name: string): boolean {
  return EXTERNAL_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Shell tools with a `command` argument. Only `bash` is registered live
 * (every platform); it is EXEC and binds standing grants to the exact
 * command. The retired `pwsh` alias was removed here with the gating sets
 * in Q6 — unknown names fail closed through the WRITE_LOCAL default.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/**
 * Code-executing tools. A standing rule / persistent grant for one of these
 * WITHOUT a concrete target (script name / exact command) would be a
 * wildcard grant of arbitrary execution, so the writers refuse target-less
 * entries. `run_script` must equal RUN_SCRIPT_TOOL_NAME in
 * `electron/lib/automation-script.ts` (kept as a literal so this module
 * stays dependency-free; `tool-names.test.ts` pins the equality).
 */
export const CODE_EXEC_TOOLS: ReadonlySet<string> = new Set(["bash", "run_script"]);
