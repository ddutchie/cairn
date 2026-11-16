"use client";

import type { ReactNode } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { RefreshSpin } from "@/components/ui/spinner";

interface AutomationModalFooterProps {
  /** Leading action(s): Develop + Edit (detail) or Start-over (dev). */
  leading?: ReactNode;
  onSyncFromManifest?: () => void;
  syncing?: boolean;
  onRunNow?: () => void;
}

/**
 * Shared automation modal footer: optional leading action, Sync from
 * manifest, Run now, Close. One site for button order and variants.
 */
export function AutomationModalFooter({
  leading,
  onSyncFromManifest,
  syncing,
  onRunNow,
}: AutomationModalFooterProps) {
  return (
    <>
      {leading}
      {onSyncFromManifest && (
        <Button variant="outline" size="sm" onClick={onSyncFromManifest} disabled={syncing}>
          <RefreshSpin size={12} spinning={syncing} className="mr-1" /> {syncing ? "Syncing…" : "Sync from manifest"}
        </Button>
      )}
      {onRunNow && (
        <Button variant="accent" size="sm" onClick={onRunNow}>
          <Play size={12} className="mr-1" /> Run now
        </Button>
      )}
      <DialogClose asChild>
        <Button variant="ghost" size="sm">Close</Button>
      </DialogClose>
    </>
  );
}
