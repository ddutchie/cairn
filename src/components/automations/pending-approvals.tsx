"use client";

import React, { useEffect } from "react";
import { ShieldAlert } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import type { ApprovalItem } from "@/store/slices/automations";

/**
 * Pending-approval cards with inline Approve once / Always allow / Deny.
 * Used by the Automations view and the Overview-tab attention queue. Refreshes
 * its list whenever the live pending count changes (the app shell poller keeps
 * the count fresh).
 */
export function PendingApprovals() {
  const {
    pendingApprovals, pendingApprovalCount,
    fetchPendingApprovals, resolveApprovalItem,
  } = useCairnStore(useShallow((s) => ({
    pendingApprovals: s.pendingApprovals,
    pendingApprovalCount: s.pendingApprovalCount,
    fetchPendingApprovals: s.fetchPendingApprovals,
    resolveApprovalItem: s.resolveApprovalItem,
  })));

  useEffect(() => {
    if (pendingApprovalCount > 0) void fetchPendingApprovals();
  }, [fetchPendingApprovals, pendingApprovalCount]);

  if (pendingApprovals.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] flex items-center gap-1.5">
        <ShieldAlert size={12} /> Pending approvals ({pendingApprovals.length})
      </h2>
      {pendingApprovals.map((item: ApprovalItem) => (
        <div key={item.id} className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-dim)]/40 p-3">
          <div className="text-sm text-[var(--text-primary)] font-medium">{item.title}</div>
          <div className="text-xs text-[var(--text-secondary)] mt-1">
            {item.body} <code className="font-mono text-[0.714rem]">{item.tool}</code>
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <Button variant="accent" size="xs" onClick={() => void resolveApprovalItem(item.id, "approved_once")}>
              Approve once
            </Button>
            <Button variant="outline" size="xs" onClick={() => void resolveApprovalItem(item.id, "approved_always")}>
              Always allow
            </Button>
            <Button variant="danger" size="xs" onClick={() => void resolveApprovalItem(item.id, "denied")}>
              Deny
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
