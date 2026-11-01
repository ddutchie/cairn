"use client";

import { useEffect, useState } from "react";
import { LogIn, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { reportIpcError } from "@/lib/ipc/client";
import { toolsClient } from "@/lib/ipc/tools";
import { subscribeMcpAuthRequired, useMcpAuthRequired } from "@/lib/mcp-auth-required";

/**
 * One chip per MCP server that needs sign-in. Chat-time connects never open the
 * browser (there is no loopback listener to catch the callback), so this is the
 * way to sign in without leaving the conversation: it runs the same flow as
 * Settings → Tools, then the chip clears itself when the sign-in completes.
 */
export function McpSignInChips() {
  const servers = useMcpAuthRequired((s) => s.servers);
  const remove = useMcpAuthRequired((s) => s.remove);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => subscribeMcpAuthRequired(), []);

  const entries = Object.entries(servers);
  if (entries.length === 0) return null;

  const signIn = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await toolsClient.startAuth("mcp", id);
      if (r.status === "already_authorized") remove(id);
      else if (r.status === "error") throw new Error(r.error);
      // "redirected": the oauthCallback listener clears the chip on success.
    } catch (err) {
      reportIpcError(err, "Couldn't start sign-in");
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  return (
    <>
      {entries.map(([id, name]) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--warning)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
          style={{ background: "color-mix(in srgb, var(--warning) 12%, transparent)" }}
        >
          <button
            type="button"
            onClick={() => void signIn(id)}
            disabled={busy[id]}
            title={`${name} isn't signed in. Click to sign in.`}
            className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] disabled:opacity-60"
          >
            {busy[id] ? <Spinner size={11} /> : <LogIn size={11} />}
            {name} not signed in · Sign in
          </button>
          <button
            type="button"
            onClick={() => remove(id)}
            aria-label={`Dismiss ${name} sign-in prompt`}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </>
  );
}
