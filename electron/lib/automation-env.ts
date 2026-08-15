/**
 * Automation env resolution + materialization (phase 3).
 *
 * Env vars expose configuration to automation scripts. Two tiers:
 *   - non-secret values are stored inline on the automation row and can be
 *     written to the folder's .env file for the dev agent to read;
 *   - secret values live ONLY in the OS keychain (secure-store kind
 *     "automation") and are injected directly into the run_script process env
 *     at run time — never written to disk.
 *
 * `resolveAutomationEnv` takes a secret resolver (injected by the caller, so
 * this module stays unit-testable without Electron) — in the runner that is
 * `getSecretValue("automation", automationId, name)`.
 */

import fs from "fs";
import type { Automation, AutomationEnv, AutomationInput } from "../db/automation-queries";
import { automationEnvFilePath, automationManifestPath } from "./automation-folder";
import { sanitizeStandingRules } from "./automation-approval";

/** Valid shell env var names — anything else is rejected at the IPC boundary. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvName(name: string): boolean {
  return typeof name === "string" && ENV_NAME_RE.test(name);
}

export type SecretResolver = (name: string) => string | null;

/**
 * Resolve the full runtime env for an automation: inline non-secret values plus
 * keychain-resolved secrets. A secret whose resolver returns null/"" is omitted
 * (the script runs without it rather than with a bogus value).
 */
export function resolveAutomationEnv(automation: Automation, resolveSecret: SecretResolver): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of automation.env ?? []) {
    if (entry.secret) {
      const value = resolveSecret(entry.name);
      if (value !== null && value !== "") out[entry.name] = value;
    } else if (typeof entry.value === "string" && entry.value !== "") {
      out[entry.name] = entry.value;
    }
  }
  return out;
}

/** Quote an env value for .env / shell source-ing (double-quoted, escaped). */
export function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write the folder's .env file from the automation's NON-SECRET env vars.
 * Secrets are intentionally never written to disk — they are injected into the
 * run_script process env directly. Best-effort: a write failure is a no-op.
 */
export function materializeEnvFile(automationDir: string, automation: Automation): void {
  const lines: string[] = [];
  for (const entry of automation.env ?? []) {
    if (entry.secret) continue;
    if (typeof entry.value !== "string" || entry.value === "") continue;
    lines.push(`${entry.name}=${quoteEnvValue(entry.value)}`);
  }
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  try {
    fs.writeFileSync(automationEnvFilePath(automationDir), content, "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Write a minimal manifest.json for the automation folder — the self-describing
 * contract the dev agent builds against and the Automations tab renders from.
 * Written with an exclusive create ("wx") so a concurrently created (agent- or
 * other-writer-authored) manifest is preserved: EEXIST is swallowed, any other
 * write error propagates to the caller.
 */
export function writeAutomationManifest(automationDir: string, automation: Automation): void {
  const filePath = automationManifestPath(automationDir);
  const manifest = {
    name: automation.name,
    description: automation.description,
    instructions: automation.instructions,
    env: (automation.env ?? []).map((e) => ({ name: e.name, secret: e.secret })),
    requires: automation.requires,
  };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
}

/** Convenience: materialize .env + manifest together before a run. */
export function prepareAutomationFolder(automationDir: string, automation: Automation): void {
  materializeEnvFile(automationDir, automation);
  writeAutomationManifest(automationDir, automation);
}

// ── Manifest (the agent-authored automation shape) ────────────────────────────

export interface AutomationManifest {
  name?: string;
  description?: string;
  /** The recipe — the automation's instructions, authored by the dev agent. */
  instructions?: string;
  /** Env schema (names + secret flags); values live in the row/keychain. */
  env?: Array<{ name: string; secret?: boolean }>;
  requires?: Array<{ kind: "mcp" | "service"; name: string }>;
  standingRules?: Array<{ tool: string; target?: string }>;
  /** Entry script name (informational). */
  entry?: string;
}

/** Read + parse the automation's manifest.json, or null when absent/invalid. */
export function readAutomationManifest(automationDir: string): AutomationManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(automationManifestPath(automationDir), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as AutomationManifest) : null;
  } catch {
    return null;
  }
}

/**
 * Merge a manifest env schema over the existing row env: manifest names + secret
 * flags win; existing values (and keychain-backed secrets) are preserved for
 * matching names; new names start empty. Returns the env array to persist.
 */
export function applyManifestEnv(
  existing: AutomationEnv[],
  manifestEnv: Array<{ name: string; secret?: boolean }>,
): AutomationEnv[] {
  const byName = new Map(existing.map((e) => [e.name, e]));
  return manifestEnv.map((m) => {
    const current = byName.get(m.name);
    const secret = Boolean(m.secret);
    if (current) return { ...current, secret };
    return { name: m.name, secret, value: "" };
  });
}

export interface ManifestSyncResult {
  /** The fields to write back onto the automation row. */
  patch: Partial<Omit<AutomationInput, "workspaceId">>;
  /** Human-readable reasons for anything in the manifest that was skipped. */
  dropped: string[];
}

/**
 * Map an agent-authored manifest.json onto the automation row: instructions,
 * env schema, standing rules (sanitised — target-less run_script/bash rules are
 * dropped, they'd be wildcard execution grants), and required connectors.
 * Pure + unit-tested; the sync IPC handler just applies the result.
 */
export function applyManifestToAutomation(
  automation: Automation,
  manifest: AutomationManifest,
): ManifestSyncResult {
  const patch: Partial<Omit<AutomationInput, "workspaceId">> = {};
  const dropped: string[] = [];
  if (typeof manifest.instructions === "string" && manifest.instructions.trim()) {
    patch.instructions = manifest.instructions.trim();
  }
  if (Array.isArray(manifest.env)) {
    patch.env = applyManifestEnv(automation.env ?? [], manifest.env);
  }
  if (Array.isArray(manifest.standingRules)) {
    const sanitised = sanitizeStandingRules(manifest.standingRules);
    patch.standingRules = sanitised.rules;
    dropped.push(...sanitised.dropped);
  }
  if (Array.isArray(manifest.requires)) {
    const seen = new Set<string>();
    patch.requires = manifest.requires
      .filter((r) => r && (r.kind === "mcp" || r.kind === "service") && typeof r.name === "string" && r.name.trim())
      .map((r) => ({ kind: r.kind, name: r.name.trim() }))
      .filter((r) => (seen.has(`${r.kind}:${r.name}`) ? false : (seen.add(`${r.kind}:${r.name}`), true)));
  }
  return { patch, dropped };
}

