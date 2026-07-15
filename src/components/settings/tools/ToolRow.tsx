"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A configured MCP server / custom service row: icon, name, enable switch, edit/delete, optional expanded body. */
export function ToolRow({
  icon,
  name,
  subtitle,
  enabled,
  onToggle,
  onEdit,
  onDelete,
  children,
}: {
  icon: React.ReactNode;
  name: string;
  subtitle: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-[var(--text-tertiary)] flex-shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-[var(--text-primary)] truncate">{name}</div>
          <div className="text-[0.714rem] text-[var(--text-tertiary)] truncate font-mono">{subtitle}</div>
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          role="switch"
          aria-checked={enabled}
          aria-label={`Enable ${name}`}
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0",
            enabled ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
          )}
        >
          <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface)] shadow-sm transition-transform", enabled ? "translate-x-4.5" : "translate-x-0.5")} />
        </button>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button variant="ghost" size="xs" onClick={onEdit}>Edit</Button>
          <Button variant="ghost" size="xs" onClick={onDelete} className="text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]">
            <Trash2 size={11} />
          </Button>
        </div>
      </div>
      {children && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}
