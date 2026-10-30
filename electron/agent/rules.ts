/**
 * Permission rules as data. Pure matching + presets; storage lives elsewhere.
 * See docs/plans/agent-engine-design.md §3.
 */
import * as path from "node:path";

export type RiskClass = "READ" | "WRITE_CAIRN" | "WRITE_LOCAL" | "EXEC" | "EXTERNAL";

/** What a tool says about one concrete invocation. */
export interface RiskInfo {
  class: RiskClass;
  /** Shell command text, for EXEC tools. */
  command?: string;
  /** Filesystem paths the call reads or writes. */
  paths?: string[];
  /** Network host, for web/external tools. */
  host?: string;
  /** The call leaves the OS sandbox; always asks the human, never grantable. */
  escalation?: boolean;
}

export type RuleEffect = "allow" | "ask" | "deny";

export interface RuleMatch {
  /** Glob on the tool name (`*` only), e.g. `mcp__github__*`. */
  tool?: string;
  risk?: RiskClass[];
  command?: { exact?: string; prefix?: string[] };
  path?: { within: "workspace" | string };
  host?: string;
}

export interface Rule {
  id: string;
  effect: RuleEffect;
  match: RuleMatch;
  scope: "session" | "workspace" | "global";
  source: "preset" | "user" | "grant" | "classifier-learned";
  note?: string;
  expiresAt?: number;
}

export interface MatchContext {
  workspaceRoot: string;
  now?: number;
}

export interface CallView {
  name: string;
  risk: RiskInfo;
}

// ── Matching ────────────────────────────────────────────────────────────────

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Collapse whitespace so cosmetic reformatting of the same command matches. */
export function canonicalCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

const SHELL_METACHARS = /[;&|<>`$()\\\n\r]/;

/**
 * Whitespace tokens of a command, or null when it contains anything that could
 * chain or substitute (`&&`, `|`, `;`, `$()`, backticks, redirects, escapes).
 * Prefix rules only ever match commands this accepts.
 */
export function tokenizeSimpleCommand(command: string): string[] | null {
  if (SHELL_METACHARS.test(command)) return null;
  const tokens = canonicalCommand(command).split(" ").filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

export function isWithin(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function matchesCommand(m: NonNullable<RuleMatch["command"]>, command: string | undefined): boolean {
  if (command === undefined) return false;
  if (m.exact !== undefined) return canonicalCommand(command) === canonicalCommand(m.exact);
  if (m.prefix) {
    const tokens = tokenizeSimpleCommand(command);
    if (!tokens || tokens.length < m.prefix.length) return false;
    return m.prefix.every((tok, i) => tokens[i] === tok);
  }
  return false;
}

export function ruleMatches(rule: Rule, call: CallView, ctx: MatchContext): boolean {
  if (rule.expiresAt !== undefined && rule.expiresAt <= (ctx.now ?? Date.now())) return false;
  const m = rule.match;
  if (m.tool !== undefined && !globToRegExp(m.tool).test(call.name)) return false;
  if (m.risk && !m.risk.includes(call.risk.class)) return false;
  if (m.command && !matchesCommand(m.command, call.risk.command)) return false;
  if (m.host !== undefined && (call.risk.host === undefined || !globToRegExp(m.host).test(call.risk.host))) return false;
  if (m.path) {
    const paths = call.risk.paths;
    if (!paths || paths.length === 0) return false;
    const root = m.path.within === "workspace" ? ctx.workspaceRoot : m.path.within;
    if (!paths.every((p) => isWithin(root, path.resolve(ctx.workspaceRoot, p)))) return false;
  }
  return true;
}

/** Higher = more specific. Used only to pick among rules with the same effect. */
function specificity(rule: Rule): number {
  const m = rule.match;
  let s = 0;
  if (m.command?.exact !== undefined) s += 40;
  if (m.command?.prefix) s += 30 + m.command.prefix.length;
  if (m.path) s += 20;
  if (m.host !== undefined) s += 15;
  if (m.tool !== undefined) s += m.tool.includes("*") ? 5 : 10;
  if (m.risk) s += 1;
  return s;
}

/** Most specific matching rule among the given effects, or undefined. */
export function findRule(
  rules: readonly Rule[],
  call: CallView,
  ctx: MatchContext,
  effects: readonly RuleEffect[],
  filter?: (rule: Rule) => boolean,
): Rule | undefined {
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!effects.includes(rule.effect) || (filter && !filter(rule)) || !ruleMatches(rule, call, ctx)) continue;
    if (!best || specificity(rule) > specificity(best)) best = rule;
  }
  return best;
}

// ── Protected paths ─────────────────────────────────────────────────────────

const PROTECTED_SEGMENTS = new Set([".git", ".cairn"]);
const PROTECTED_BASENAMES = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.zshenv|\.profile)$/;
const PROTECTED_EXT = /\.(pem|key|p12|pfx)$/;

export function isProtectedPath(p: string, workspaceRoot: string, extra: readonly string[] = []): boolean {
  const abs = path.resolve(workspaceRoot, p);
  const parts = abs.split(path.sep);
  if (parts.some((seg) => PROTECTED_SEGMENTS.has(seg))) return true;
  if (/[\\/]\.github[\\/]workflows[\\/]/.test(abs)) return true;
  const base = path.basename(abs);
  if (PROTECTED_BASENAMES.test(base) || PROTECTED_EXT.test(base)) return true;
  return extra.some((e) => isWithin(path.resolve(workspaceRoot, e), abs));
}

// ── Presets and grants ──────────────────────────────────────────────────────

export type PresetId = "cairn-data" | "workspace-edits" | "safe-shell" | "read-only";

function preset(id: PresetId, rules: Array<Omit<Rule, "id" | "scope" | "source">>): Rule[] {
  return rules.map((r, i) => ({ ...r, id: `preset:${id}:${i}`, scope: "global", source: "preset" }));
}

const SAFE_SHELL = ["ls", "pwd", "git status", "git diff", "git log"];

export const PRESETS: Record<PresetId, Rule[]> = {
  "cairn-data": preset("cairn-data", [{ effect: "allow", match: { risk: ["WRITE_CAIRN"] }, note: "Cairn notes, tasks, board and idea flow" }]),
  "workspace-edits": preset("workspace-edits", [{ effect: "allow", match: { risk: ["WRITE_LOCAL"], path: { within: "workspace" } }, note: "File edits inside the workspace" }]),
  "safe-shell": preset("safe-shell", SAFE_SHELL.map((exact) => ({ effect: "allow" as const, match: { risk: ["EXEC" as const], command: { exact } } }))),
  "read-only": preset("read-only", [{ effect: "deny", match: { risk: ["WRITE_CAIRN", "WRITE_LOCAL", "EXEC", "EXTERNAL"] }, note: "Read-only" }]),
};

export function presetRules(...ids: PresetId[]): Rule[] {
  return ids.flatMap((id) => PRESETS[id]);
}

export type GrantKind = "tool" | "command";

/** Grants the UI may offer for a call. EXEC grants are exact-command only. */
export function offeredGrants(risk: RiskInfo): GrantKind[] {
  if (risk.class === "READ") return [];
  if (risk.escalation) return [];
  if (risk.class === "EXEC") return risk.command && canonicalCommand(risk.command) ? ["command"] : [];
  return ["tool"];
}

let grantSeq = 0;
export function grantRule(call: CallView, grant: GrantKind): Rule {
  const id = `grant:${Date.now().toString(36)}:${(grantSeq++).toString(36)}`;
  if (grant === "command") {
    return { id, effect: "allow", scope: "session", source: "grant", match: { tool: call.name, command: { exact: canonicalCommand(call.risk.command ?? "") } } };
  }
  return { id, effect: "allow", scope: "session", source: "grant", match: { tool: call.name } };
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface RuleStore {
  list(): readonly Rule[];
  add(rule: Rule): void;
  remove(id: string): void;
}

export function createRuleStore(initial: readonly Rule[] = []): RuleStore {
  const rules = [...initial];
  return {
    list: () => rules,
    add: (rule) => { rules.push(rule); },
    remove: (id) => { const i = rules.findIndex((r) => r.id === id); if (i >= 0) rules.splice(i, 1); },
  };
}
