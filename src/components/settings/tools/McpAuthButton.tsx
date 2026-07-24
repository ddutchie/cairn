"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, CheckCircle, XCircle, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

type ToolType = "mcp" | "service";

/** The IPC method set differs only by tool type; pick the right one. */
function api(toolType: ToolType) {
  const t = window.electron?.tools;
  if (!t) return null;
  return toolType === "mcp"
    ? {
        status: t.mcpAuthStatus,
        start: t.startMcpAuth,
        signOut: t.signOutMcp,
        cancel: t.cancelMcpAuth,
      }
    : {
        status: t.serviceAuthStatus,
        start: t.startServiceAuth,
        signOut: t.signOutService,
        cancel: t.cancelServiceAuth,
      };
}

/**
 * OAuth sign-in / sign-out control for an MCP server OR custom HTTP service that
 * uses OAuth. Both share the exact same browser flow (loopback redirect +
 * `tools:oauthCallback` completion event); only the four IPC method names differ,
 * selected by {@link toolType}.
 */
export function AuthButton({ toolId, toolType }: { toolId: string; toolType: ToolType }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api(toolType)?.status(toolId);
    setConnected(r?.connected ?? false);
  }, [toolId, toolType]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // Refresh when an OAuth callback for this tool completes. Both MCP and
    // service flows emit the same event keyed by the tool id (as serverId).
    const off = window.electron?.tools.onOauthCallback((e) => {
      if (e.serverId && e.serverId !== toolId) return;
      setBusy(false);
      if (e.status === "authorized") {
        setError(null);
        void refresh();
      } else if (e.status === "error") {
        setError(e.error ?? "Sign-in failed");
      }
    });
    return () => { off?.(); };
  }, [toolId, refresh]);

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api(toolType)?.start(toolId);
      if (r?.status === "already_authorized") {
        setBusy(false);
        void refresh();
      } else if (r?.status === "error") {
        setBusy(false);
        setError(r.error ?? "Sign-in failed");
      }
      // "redirected": browser opened; wait for onOauthCallback to flip busy off.
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  }, [toolId, toolType, refresh]);

  const signOut = useCallback(async () => {
    await api(toolType)?.signOut(toolId);
    setError(null);
    void refresh();
  }, [toolId, toolType, refresh]);

  const cancel = useCallback(async () => {
    await api(toolType)?.cancel(toolId);
    // The completion listener will flip busy off with a "cancelled" error;
    // clear busy eagerly so the button is responsive even if that races.
    setBusy(false);
  }, [toolId, toolType]);

  return (
    <div className="flex items-center gap-2">
      {connected ? (
        <>
          <span className="flex items-center gap-1 text-[0.714rem] text-[var(--success)]">
            <CheckCircle size={12} /> Connected
          </span>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOut size={12} /> Sign out
          </Button>
        </>
      ) : busy ? (
        <>
          <span className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)]">
            <Loader2 size={12} className="animate-spin" /> Waiting for browser…
          </span>
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={() => void signIn()}>
          <LogIn size={12} /> Sign in
        </Button>
      )}
      {error && (
        <span className="flex items-center gap-1 text-[0.714rem] text-[var(--danger)] truncate max-w-[14rem]" title={error}>
          <XCircle size={12} /> {error}
        </span>
      )}
    </div>
  );
}

/** Back-compat thin wrapper for the MCP call site. */
export function McpAuthButton({ serverId }: { serverId: string }) {
  return <AuthButton toolId={serverId} toolType="mcp" />;
}
