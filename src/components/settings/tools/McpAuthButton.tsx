"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, CheckCircle, XCircle, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

/** OAuth sign-in / sign-out control for an MCP server that uses OAuth auth. */
export function McpAuthButton({ serverId }: { serverId: string }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await window.electron?.tools.mcpAuthStatus(serverId);
    setConnected(r?.connected ?? false);
  }, [serverId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // Refresh when an OAuth callback for this server completes.
    const off = window.electron?.tools.onOauthCallback((e) => {
      if (e.serverId && e.serverId !== serverId) return;
      setBusy(false);
      if (e.status === "authorized") {
        setError(null);
        void refresh();
      } else if (e.status === "error") {
        setError(e.error ?? "Sign-in failed");
      }
    });
    return () => { off?.(); };
  }, [serverId, refresh]);

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.electron?.tools.startMcpAuth(serverId);
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
  }, [serverId, refresh]);

  const signOut = useCallback(async () => {
    await window.electron?.tools.signOutMcp(serverId);
    setError(null);
    void refresh();
  }, [serverId, refresh]);

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
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void signIn()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
          {busy ? "Waiting for browser…" : "Sign in"}
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
