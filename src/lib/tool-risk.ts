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
