/**
 * mcp-dsh-bridge — parity-gated spike: route ONE external MCP connector through
 * `@deepseek-ai/dsh-mcp-client` instead of Cairn's hand bridge
 * (`electron/lib/mcp-client.ts` + `registerExternalCairnTools` below).
 *
 * Goal (per docs/dsh-product-decisions.md): prove that community MCP connectors
 * can move behind the dsh backend with ZERO model-visible or user-visible
 * change — same tool names, same JSON schemas, same EXTERNAL risk class and
 * approval gating. The merge bar is the parity proof
 * (`mcp-dsh-bridge.test.ts`), not just the mount.
 *
 * Opt-in, default OFF — two equivalent gates: `CAIRN_DSH_MCP_SPIKE=<serverId>`
 * names a single server (dogfooding without UI), or a workspace server row
 * flagged `dshPath` (dev-only ToolsSettings toggle). No gate set → this module
 * mounts nothing and excludes nothing (zero behavior change). A gated server
 * is served EXCLUSIVELY by the dsh path (the hand bridge skips it via
 * `excludeServerIds`) and ONLY when every parity precondition below holds —
 * otherwise it fail-closes to the hand bridge with a logged reason.
 *
 * Parity preconditions (checked in `maybeMountDshMcpSpike`, in order):
 *   1. The server is enabled AND in scope for the project (it appears in the
 *      hand bridge's own def list — same enabled+attached+disabledTools view
 *      the model would otherwise be offered).
 *   2. Transport eligibility (`toDshMcpConfig`): dsh-mcp-client speaks stdio +
 *      Streamable HTTP only. Cairn SSE servers, OAuth servers, and servers
 *      whose headers contain `secret://` refs stay on the hand bridge, which
 *      owns the SSE transport, the OAuth provider, and main-process secret
 *      resolution. stdio servers are dsh-only territory (Cairn never spawned
 *      MCP child processes) and out of scope for this spike.
 *   3. Name parity: dsh publishes `mcp__<serverName>__<rawName>` VERBATIM for
 *      clean names — identical to Cairn's `namespaceToolName` when
 *      `serverName === serverId`. For exotic raw names (chars outside
 *      `[A-Za-z0-9_-]`, or a qualified name over 64 chars) dsh normalizes and
 *      appends a 12-hex hash while Cairn passes the name through verbatim, so
 *      the two paths DIVERGE. After mounting, the registered dsh name set must
 *      equal the hand-bridge name set exactly (plus per-tool
 *      description/parameters deep-equality); any mismatch disposes the dsh
 *      mount and fail-closes to the hand bridge.
 *
 * Why approval parity holds by construction (locked by tests, not by hope):
 * risk classification (`shared/agent/tool-risk.ts`) and the approval gate
 * (`cairnApprovalPlugin`, `shared/agent/approval-mode.ts`) are pure functions
 * of the tool NAME over `ctx.tools` events — they fire identically no matter
 * which bridge registered the tool. The invariant the tests pin is therefore
 * that every dsh-registered name stays inside the `mcp__` prefix the
 * EXTERNAL classifier matches; a non-prefixed name would silently drop to
 * WRITE_LOCAL (session-grantable) instead of EXTERNAL (always-ask).
 *
 * Sampling / elicitation / roots: NEITHER side implements them. Both clients
 * construct the MCP SDK `Client` with `capabilities: {}` and register no
 * `sampling/createMessage`, `elicitation`, or `roots` handlers (Cairn:
 * `electron/lib/mcp-client.ts` `connect()`; dsh: `connection.ts`
 * `connectGeneration()`). A server that issues such requests fails identically
 * on both paths (SDK "method not found"-style error surfaced to the model as
 * an error) — parity holds vacuously, and the probe tools in the parity test
 * prove the observable behavior matches. If either side ever ADDS handlers,
 * the probes will catch the divergence.
 *
 * Known NON-gated divergences (same model-visible text, different envelope —
 * follow-ups, not merge blockers):
 *   - Error contract: the hand bridge returns `"Error: …"` STRINGS (never
 *     throws); the dsh executor THROWS on `isError`, so the ToolRuntime
 *     produces an `isError` tool result. Same text, different `isError` flag.
 *   - Output schema: hand tools declare `{type:"json"}` string output; dsh
 *     tools declare `{content, structuredContent}` object output with a text
 *     render projection. The RENDERED model text matches for text content.
 *   - Reconnect/supervision: dsh re-syncs on ToolListChanged + reconnects with
 *     backoff; the hand bridge re-lists per turn and never watches. Steady
 *     state is identical; transient failure windows may differ.
 */

import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import {
  apply as mcpClientApply,
  inject as mcpClientInject,
  name as mcpClientName,
  type Config as DshMcpConfig,
} from "@deepseek-ai/dsh-mcp-client";
import type { HostStore } from "./host-store";

/** Env var naming the single MCP server id to route via dsh (unset = spike off). */
export const DSH_MCP_SPIKE_ENV = "CAIRN_DSH_MCP_SPIKE";

/** dsh's serverName grammar — renaming to fit it would break name parity, so non-matching ids are ineligible. */
const DSH_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Per-tool-call timeout: dsh default (60s) matches the hand bridge CALL_TIMEOUT_MS. */
const TOOL_CALL_TIMEOUT_MS = 60_000;

export interface SpikeMcpServerRow {
  id: string;
  baseUrl?: string;
  transport: string;
  headers?: Record<string, string> | null;
  authMode?: string | null;
  enabled?: boolean;
  /** Dev-only per-server opt-in (ToolsSettings toggle) — same effect as the env var. */
  dshPath?: boolean;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  cwd?: string | null;
}

export type DshMcpEligibility =
  | { eligible: true; serverName: string; url: string; headers: Record<string, string> }
  | { eligible: false; reason: string };

/**
 * Map a Cairn stored MCP server row onto a dsh-mcp-client Streamable HTTP
 * config. Pure — exported for unit tests. Ineligible servers keep their exact
 * reason so the caller can log WHY the spike declined them.
 */
export function toDshMcpConfig(server: SpikeMcpServerRow): DshMcpEligibility {
  if (server.transport !== "http") {
    return {
      eligible: false,
      reason: `transport-${server.transport}: dsh-mcp-client speaks stdio + Streamable HTTP only (no SSE)`,
    };
  }
  if ((server.authMode ?? "none") === "oauth") {
    return {
      eligible: false,
      reason: "auth-oauth: the hand bridge owns the OAuth provider + keychain refresh",
    };
  }
  const headers = server.headers ?? {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" && v.includes("secret://")) {
      return {
        eligible: false,
        reason: `header-secret:${k}: secret:// refs resolve only in the hand bridge (main process)`,
      };
    }
  }
  if (!DSH_SERVER_NAME_RE.test(server.id)) {
    return {
      eligible: false,
      reason: `server-name: id ${JSON.stringify(server.id)} is outside dsh's [A-Za-z0-9_-]{1,32} namespace (renaming would break tool-name parity)`,
    };
  }
  if (!server.baseUrl) return { eligible: false, reason: "base-url: missing" };
  let url: URL;
  try {
    url = new URL(server.baseUrl);
  } catch {
    return { eligible: false, reason: `base-url: ${JSON.stringify(server.baseUrl)} is not a valid URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { eligible: false, reason: `base-url: protocol ${JSON.stringify(url.protocol)} is not http(s)` };
  }
  return { eligible: true, serverName: server.id, url: server.baseUrl, headers: { ...headers } };
}

export type DshStdioEligibility =
  | { eligible: true; serverName: string; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { eligible: false; reason: string };

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_TOKEN_RE = /^[A-Za-z0-9_@.+-]+$/;

/**
 * Validate a stdio row for dsh mounting. Pure — no secret resolution here;
 * callers resolve `secret://` env refs via HostStore BEFORE building the
 * dsh config (main process only). A raw `secret://` value is ineligible
 * rather than leaked.
 */
export function toDshStdioEligibility(
  server: SpikeMcpServerRow,
  opts: { workspacePath?: string; cwd?: string } = {},
): DshStdioEligibility {
  if (server.transport !== "stdio") {
    return { eligible: false, reason: `transport-${server.transport}: not stdio` };
  }
  const command = (server.command ?? "").trim();
  if (!command) return { eligible: false, reason: "invalid-stdio: command is required" };
  if (command.includes(" ") || /[;&|<>$`'"\\]/.test(command)) {
    return { eligible: false, reason: "invalid-stdio: command must be a bare executable or absolute path (no shell)" };
  }
  if (command.startsWith("/") ? command.includes("..") : !COMMAND_TOKEN_RE.test(command)) {
    return { eligible: false, reason: "invalid-stdio: command must be a bare executable name or absolute path" };
  }
  const args = server.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return { eligible: false, reason: "invalid-stdio: args must be an array of strings" };
  }
  const env = server.env ?? {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return { eligible: false, reason: "invalid-stdio: env must be an object" };
  }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(k)) return { eligible: false, reason: `invalid-stdio: env var ${JSON.stringify(k)} is invalid` };
    if (typeof v !== "string") return { eligible: false, reason: `invalid-stdio: env var ${k} must be a string` };
    if (v.includes("secret://")) {
      return { eligible: false, reason: `env-secret:${k}: resolve secret:// refs via HostStore before mounting` };
    }
  }
  const cwd = ((server.cwd ?? "").trim() || opts.cwd?.trim() || opts.workspacePath?.trim() || process.cwd()).trim();
  if (!cwd.startsWith("/")) return { eligible: false, reason: "invalid-stdio: cwd must be an absolute path" };
  if (!DSH_SERVER_NAME_RE.test(server.id)) {
    return { eligible: false, reason: `server-name: id ${JSON.stringify(server.id)} is outside dsh's [A-Za-z0-9_-]{1,32} namespace` };
  }
  return { eligible: true, serverName: server.id, command, args: [...args], env: { ...env }, cwd };
}

/** Set-difference of two tool-name lists (order-insensitive, duplicates collapsed). */
export function diffToolNameSets(
  cairnNames: readonly string[],
  dshNames: readonly string[],
): { missing: string[]; extra: string[] } {
  const cairn = new Set(cairnNames);
  const dsh = new Set(dshNames);
  return {
    missing: [...cairn].filter((n) => !dsh.has(n)).sort(),
    extra: [...dsh].filter((n) => !cairn.has(n)).sort(),
  };
}

export interface DshSpikeMount {
  /**
   * Fiber disposers to add to the turn's resources (turn-scoped, like every
   * other per-turn mount). The disposer returns the fiber teardown chain so
   * turn-end `disposeAsync()` awaits full quiescence (connection close + tool
   * unregister) instead of racing the next turn's mounts.
   */
  disposers: Array<() => unknown>;
  /** Server ids the hand bridge must skip this turn (served by the dsh path). Empty unless the spike fully verified. */
  excludedServerIds: Set<string>;
}

const EMPTY_MOUNT: DshSpikeMount = { disposers: [], excludedServerIds: new Set() };

function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

/**
 * Opt-in spike mount (default OFF). Candidates are the `CAIRN_DSH_MCP_SPIKE`
 * (or `opts.serverId`) server plus every workspace server flagged `dshPath`
 * (dev-only ToolsSettings toggle). Each candidate mounts dsh-mcp-client on
 * `ctx` and verifies name+schema parity against the hand bridge's own def
 * list; results merge (disposers + exclusions). EVERY failure mode — gate
 * off, unknown/disabled/out-of-scope server, ineligible transport/auth, empty
 * def list, mount error, parity mismatch — fail-closes to the hand bridge
 * (empty mount, empty exclusion) with a logged reason. Never throws into
 * the turn.
 */
export async function maybeMountDshMcpSpike(
  ctx: Context,
  host: HostStore,
  workspaceId: string,
  projectId: string,
  opts: { serverId?: string; log?: (msg: string) => void } = {},
): Promise<DshSpikeMount> {
  const log = opts.log ?? ((msg: string) => console.warn(`[mcp-dsh-spike] ${msg}`));
  const candidates = new Set<string>();
  const envServer = opts.serverId ?? process.env[DSH_MCP_SPIKE_ENV];
  if (envServer) candidates.add(envServer);
  try {
    const rows = (host.getMcpServers?.(workspaceId) ?? []) as SpikeMcpServerRow[];
    for (const row of rows) if (row?.dshPath === true) candidates.add(row.id);
  } catch (err) {
    log(`server listing failed (${(err as Error)?.message ?? String(err)}) — env-only candidates`);
  }
  if (candidates.size === 0) return EMPTY_MOUNT;
  const disposers: Array<() => unknown> = [];
  const excludedServerIds = new Set<string>();
  for (const serverId of candidates) {
    const one = await mountOneServer(ctx, host, workspaceId, projectId, serverId, log);
    one.disposers.forEach((d) => disposers.push(d));
    one.excludedServerIds.forEach((id) => excludedServerIds.add(id));
  }
  return { disposers, excludedServerIds };
}

/**
 * Long-term mount: every in-scope stdio server via dsh-mcp-client, plus the
 * opt-in HTTP spike. Stdio has no hand-bridge equivalent, so there is no
 * parity gate — validation + serverName grammar + a non-empty mount are the
 * bar. Secret env refs resolve via HostStore (main process, keychain) before
 * the child spawns; unresolved/raw secret:// values never reach the child.
 * Never throws into the turn.
 */
export async function maybeMountDshMcpServers(
  ctx: Context,
  host: HostStore,
  workspaceId: string,
  projectId: string,
  opts: { serverId?: string; workspacePath?: string; cwd?: string; log?: (msg: string) => void } = {},
): Promise<DshSpikeMount> {
  const log = opts.log ?? ((msg: string) => console.warn(`[mcp-dsh] ${msg}`));
  // HTTP spike first (exclusions flow to the hand bridge below).
  const spike = await maybeMountDshMcpSpike(ctx, host, workspaceId, projectId, { serverId: opts.serverId, log });
  const disposers: Array<() => unknown> = [...spike.disposers];
  const excludedServerIds = new Set<string>(spike.excludedServerIds);
  try {
    const scoped = (typeof host.getScopedMcpServers === "function"
      ? host.getScopedMcpServers(workspaceId, projectId)
      : host.getMcpServers?.(workspaceId) ?? []) as SpikeMcpServerRow[];
    const stdioRows = scoped.filter((r) => r?.transport === "stdio" && r?.enabled !== false);
    for (const row of stdioRows) {
      if (excludedServerIds.has(row.id)) continue;
      const one = await mountOneStdioServer(ctx, host, row, { workspacePath: opts.workspacePath, cwd: opts.cwd, log });
      one.disposers.forEach((d) => disposers.push(d));
      // Stdio never appears in hand-bridge defs, so no exclusion is needed —
      // but track it so callers can distinguish "served by dsh".
      one.excludedServerIds.forEach((id) => excludedServerIds.add(id));
    }
  } catch (err) {
    log(`stdio listing failed (${(err as Error)?.message ?? String(err)}) — http spike unchanged`);
  }
  return { disposers, excludedServerIds };
}

async function mountOneStdioServer(
  ctx: Context,
  host: HostStore,
  row: SpikeMcpServerRow,
  opts: { workspacePath?: string; cwd?: string; log: (msg: string) => void },
): Promise<DshSpikeMount> {
  const log = opts.log;
  const serverId = row.id;
  try {
    // Resolve secret:// env refs in the main process before the child spawns.
    let env: Record<string, string> = { ...(row.env ?? {}) };
    try {
      const resolve = (host as unknown as { resolveStdioEnv?: (e: Record<string, string>) => Record<string, string> }).resolveStdioEnv;
      if (typeof resolve === "function") env = resolve.call(host, env);
      else {
        const generic = (host as unknown as { resolveSecrets?: (v: Record<string, string>) => Record<string, string> }).resolveSecrets;
        if (typeof generic === "function") env = generic.call(host, env);
      }
    } catch (err) {
      log(`server ${JSON.stringify(serverId)} secret resolution failed (${(err as Error)?.message ?? String(err)}) — skipping`);
      return EMPTY_MOUNT;
    }
    const elig = toDshStdioEligibility({ ...row, env }, { workspacePath: opts.workspacePath, cwd: opts.cwd });
    if (!elig.eligible) {
      log(`server ${JSON.stringify(serverId)} ineligible for dsh stdio (${elig.reason}) — skipping`);
      return EMPTY_MOUNT;
    }
    const config: DshMcpConfig = {
      transport: "stdio",
      serverName: elig.serverName,
      command: elig.command,
      args: elig.args,
      env: elig.env,
      cwd: elig.cwd,
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
    };
    const plug = ctx.plugin as unknown as (
      p: { apply: typeof mcpClientApply; inject: typeof mcpClientInject; name: typeof mcpClientName },
      c: DshMcpConfig,
    ) => Promise<{ dispose: () => void }>;
    const fiber = await plug(
      { apply: mcpClientApply, inject: mcpClientInject, name: mcpClientName },
      config,
    );
    const disposeFiber = (): unknown => {
      try {
        const r = (fiber as unknown as { dispose: () => unknown }).dispose();
        if (r && typeof (r as Promise<unknown>).then === "function") {
          return (r as Promise<unknown>).catch((e) => log(`dispose failed: ${(e as Error)?.message ?? String(e)}`));
        }
        return r;
      } catch (e) {
        log(`dispose failed: ${(e as Error)?.message ?? String(e)}`);
      }
    };
    log(`server ${JSON.stringify(serverId)} on dsh stdio path (cmd ${elig.command})`);
    return { disposers: [disposeFiber], excludedServerIds: new Set([serverId]) };
  } catch (e) {
    log(`stdio mount failed for ${JSON.stringify(serverId)} (${(e as Error)?.message ?? String(e)}) — skipping`);
    return EMPTY_MOUNT;
  }
}

async function mountOneServer(
  ctx: Context,
  host: HostStore,
  workspaceId: string,
  projectId: string,
  serverId: string,
  log: (msg: string) => void,
): Promise<DshSpikeMount> {
  const prefix = `mcp__${serverId}__`;

  try {
    const row = host.getMcpServer(workspaceId, serverId) as SpikeMcpServerRow | undefined;
    if (!row) {
      log(`server ${JSON.stringify(serverId)} not found in workspace — spike off, hand bridge unchanged`);
      return EMPTY_MOUNT;
    }
    if (row.enabled === false) {
      log(`server ${JSON.stringify(serverId)} is disabled — spike off, hand bridge unchanged`);
      return EMPTY_MOUNT;
    }
    const elig = toDshMcpConfig(row);
    if (!elig.eligible) {
      log(`server ${JSON.stringify(serverId)} ineligible for dsh path (${elig.reason}) — hand bridge unchanged`);
      return EMPTY_MOUNT;
    }
    // The hand bridge's own scoped view: enabled + attached (global/project) +
    // disabledTools-filtered. Empty (out of scope, or server down) → do not
    // mount: the spike must never offer a tool the loop wasn't offered, nor
    // resurrect an unreachable server the hand bridge already degrades to [].
    const scoped = await host.getExternalToolDefs(workspaceId, projectId);
    const expected = (scoped as Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>).filter(
      (d) => d.function.name.startsWith(prefix),
    );
    if (expected.length === 0) {
      log(`server ${JSON.stringify(serverId)} has no in-scope tools this turn — spike off, hand bridge unchanged`);
      return EMPTY_MOUNT;
    }

    const config: DshMcpConfig = {
      transport: "streamable-http",
      serverName: elig.serverName,
      url: elig.url,
      headers: elig.headers,
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      // Contained startup (log + reconnect loop) like the hand bridge's
      // degrade-to-[] on unreachable servers — never fail the turn.
      failOnStartupError: false,
    };
    const plug = ctx.plugin as unknown as (
      p: { apply: typeof mcpClientApply; inject: typeof mcpClientInject; name: typeof mcpClientName },
      c: DshMcpConfig,
    ) => Promise<{ dispose: () => void }>;
    const fiber = await plug(
      { apply: mcpClientApply, inject: mcpClientInject, name: mcpClientName },
      config,
    );
    const disposeFiber = (): unknown => {
      try {
        const r = (fiber as unknown as { dispose: () => unknown }).dispose();
        if (r && typeof (r as Promise<unknown>).then === "function") {
          return (r as Promise<unknown>).catch((e) => log(`dispose failed: ${(e as Error)?.message ?? String(e)}`));
        }
        return r;
      } catch (e) {
        log(`dispose failed: ${(e as Error)?.message ?? String(e)}`);
      }
    };

    try {
      const tools = ctx.tools as unknown as {
        schemas?: () => Array<{ name?: string; description?: string; parameters?: unknown }>;
      };
      const dshSchemas = (tools.schemas?.() ?? []).filter((s) => typeof s.name === "string" && s.name.startsWith(prefix));
      const { missing, extra } = diffToolNameSets(
        expected.map((d) => d.function.name),
        dshSchemas.map((s) => s.name as string),
      );
      if (missing.length > 0 || extra.length > 0) {
        log(
          `name parity FAILED for ${JSON.stringify(serverId)} (missing: ${missing.join(",") || "—"}; extra: ${extra.join(",") || "—"}) — disposing dsh mount, hand bridge unchanged`,
        );
        disposeFiber();
        return EMPTY_MOUNT;
      }
      const byName = new Map(dshSchemas.map((s) => [s.name as string, s]));
      for (const def of expected) {
        const got = byName.get(def.function.name);
        const wantDesc = def.function.description ?? "";
        const gotDesc = got?.description ?? "";
        const wantParams = stableStringify(def.function.parameters ?? {});
        const gotParams = stableStringify(got?.parameters ?? {});
        if (gotDesc !== wantDesc || wantParams !== gotParams) {
          log(
            `schema parity FAILED for ${JSON.stringify(def.function.name)} (description or parameters differ) — disposing dsh mount, hand bridge unchanged`,
          );
          disposeFiber();
          return EMPTY_MOUNT;
        }
      }
    } catch (e) {
      log(`parity verification threw (${(e as Error)?.message ?? String(e)}) — disposing dsh mount, hand bridge unchanged`);
      disposeFiber();
      return EMPTY_MOUNT;
    }

    log(`server ${JSON.stringify(serverId)} on dsh path (${expected.length} tools, parity verified)`);
    return { disposers: [disposeFiber], excludedServerIds: new Set([serverId]) };
  } catch (e) {
    log(`mount failed (${(e as Error)?.message ?? String(e)}) — hand bridge unchanged`);
    return EMPTY_MOUNT;
  }
}
