"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type HeaderRow, looksSecret, inputCls, labelCls } from "./helpers";

/**
 * Secret-aware header editor. Header values that look like a secret placeholder
 * (or an existing secret:// ref) are rendered as a masked field; the real value
 * is written to the keychain by the parent's resolveHeaders before saving —
 * never stored in the config literally.
 */
export function HeaderEditor({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  return (
    <div className="space-y-2">
      <label className={labelCls}>Headers</label>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            value={row.name}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
            placeholder="Header-Name"
            className={cn(inputCls, "flex-1 font-mono")}
          />
          <input
            value={row.value}
            type={row.isSecret && row.value.startsWith("secret://") ? "password" : "text"}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value, isSecret: looksSecret(e.target.value) } : r)))
            }
            placeholder={row.isSecret ? "secret value" : "value"}
            className={cn(inputCls, "flex-1", row.isSecret && "font-mono")}
          />
          <button
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label="Remove header"
            className="text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors p-1"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <Button variant="ghost" size="xs" onClick={() => onChange([...rows, { name: "", value: "", isSecret: false }])}>
        <Plus size={11} /> Add header
      </Button>
    </div>
  );
}
