export type RiskClass = "READ" | "WRITE_LOCAL" | "EXEC" | "EXTERNAL";

export function riskForTool(name: string): RiskClass {
  if (/^(?:mcp|svc)__/.test(name)) return "EXTERNAL";
  if (["write", "edit", "create_note", "ensure_note", "patch_note", "append_to_note", "create_task", "update_task"].includes(name)) return "WRITE_LOCAL";
  if (name === "bash" || name === "spawn_subagent") return "EXEC";
  return "READ";
}

export function approvalPreview(name: string, args: Record<string, unknown> = {}): string {
  const value = name === "bash"
    ? args.command
    : name === "write"
      ? args.content
      : name.startsWith("mcp__") || name.startsWith("svc__")
        ? JSON.stringify(args, null, 2)
        : args.path ?? args.title ?? args.query ?? "";
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  const lines = text.split("\n").slice(0, 5);
  const clamped = lines.join("\n").slice(0, 420);
  return clamped + (clamped.length < text.length ? "…" : "");
}

/**
 * Which "always allow" grant the approval card offers for a tool, plus a
 * plain-English statement of where the action reaches. Pure so the approval
 * card's scoping can be verified without an Electron/IPC harness:
 *
 * - `command` — bash only: bind the standing grant to this exact command.
 * - `session` — writes and external calls: allow this tool for the session.
 * - `none`    — reads and other exec: one-off allow/deny only, no standing grant.
 *
 * A READ never offers a standing grant (nothing consequential to pre-authorise),
 * and an EXTERNAL action is always scoped to the session (never a blanket
 * "always", since it leaves the machine).
 */
export function approvalGrantScope(name: string): "command" | "session" | "none" {
  const risk = riskForTool(name);
  if (risk === "EXEC" && name === "bash") return "command";
  if (risk !== "READ" && risk !== "EXEC") return "session";
  return "none";
}

/** Where an action reaches, for the approval card's one-line scope note. */
export function approvalScopeLabel(name: string): string {
  const risk = riskForTool(name);
  // "this device" rather than "this Mac" — Cairn ships on Windows and Linux too.
  if (risk === "EXTERNAL") return "leaves this device via a connected service";
  if (risk === "EXEC") return "runs on this device";
  return "stays on this device";
}
