/** Helpers shared by several Cairn plugins. */
import "../ctx-augment";
import { isSecretFile, bashReferencesSecretFile } from "../host-store";
import { isShellTool } from "../../../shared/agent/tool-risk";
import { makeSessionProjection, type SessionProjectionKind } from "../../../shared/agent/session-projection";
import { resolveToolCallView } from "../cordis-context";

/** Tool-authored chip title (dsh `presentCall`) with bare-name fallback. */
export function toolCallTitle(name: string, argsRaw?: string): string {
  try {
    return resolveToolCallView(name, argsRaw)?.title as string ?? name;
  } catch { return name; }
}
export function secretPathForCall(name: string, args: Record<string, unknown>): string | undefined {
  if (isShellTool(name) && typeof args.command === "string" && bashReferencesSecretFile(args.command)) {
    // use the raw command as key — exact match for session grant
    return `bash:${args.command}`;
  }
  const candidates = ["file_path", "path", "filePath", "file", "filepath"] as const;
  for (const k of candidates) {
    const v = args[k];
    if (typeof v === "string" && v && isSecretFile(v)) return v;
  }
  // also check nested file_path in some tools
  return undefined;
}

export function sendProjection(send: (channel: string, payload: Record<string, unknown>) => void, sessionId: string, kind: SessionProjectionKind, data: Record<string, unknown>): void {
  send("session:projection", makeSessionProjection(sessionId, kind, data as never) as unknown as Record<string, unknown>);
}
