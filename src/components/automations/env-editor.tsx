"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, Plus, Trash2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { cn, id } from "@/lib/utils";
import type { AutomationEnvSpec } from "@/store/slices/automations";

/**
 * Env-var editor for an automation's scripts.
 *
 * Non-secret values are stored inline on the automation row and written to the
 * folder's .env file at run time. Secret values live in the OS keychain and are
 * NEVER shown or returned — the editor only shows whether one is set. Saving a
 * secret with a blank value keeps the existing stored value.
 */
export function EnvEditor({
  automationId,
  onChanged,
}: {
  automationId: string;
  onChanged?: () => void;
}) {
  interface Row {
    key: string;
    name: string;
    secret: boolean;
    value: string;
    set: boolean;
    removed: boolean;
    /** How the row was loaded — lets save() tell a toggle/clear from a new row. */
    originalSecret: boolean;
    originalValue: string;
  }

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  const load = useCallback(async () => {
    if (!window.electron) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.electron.automation.env.get(automationId);
      if ("error" in (res ?? {})) {
        setError((res as { error: string }).error);
        return;
      }
      const spec = (res ?? []) as AutomationEnvSpec[];
      setRows(spec.map((s) => ({
        key: id(),
        name: s.name,
        secret: s.secret,
        value: s.secret ? "" : (s.value ?? ""),
        set: Boolean(s.set),
        removed: false,
        originalSecret: s.secret,
        originalValue: s.secret ? "" : (s.value ?? ""),
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [automationId]);

  useEffect(() => { void load(); /* eslint-disable-line react-hooks/set-state-in-effect */ }, [load]);

  const addRow = () => {
    setRows((prev) => [...prev, { key: id(), name: "", secret: false, value: "", set: false, removed: false, originalSecret: false, originalValue: "" }]);
  };

  const updateRow = (key: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, removed: true } : r)));
  };

  const visible = useMemo(() => rows.filter((r) => !r.removed), [rows]);

  const save = async () => {
    if (!window.electron) return;
    setSaving(true);
    setError(null);
    try {
      const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
      const names = new Set<string>();
      for (const row of rows) {
        if (row.removed) continue;
        const name = row.name.trim();
        if (!name) continue;
        if (!NAME_RE.test(name)) {
          setError(`Invalid env var name "${name}" — use only letters, digits and underscores.`);
          return;
        }
        if (names.has(name)) {
          setError(`Duplicate env var "${name}" — each name can appear once.`);
          return;
        }
        names.add(name);
      }

      // Remove first (so a rename + re-add lands cleanly).
      for (const row of rows) {
        if (row.removed && row.name.trim()) {
          await window.electron.automation.env.delete(automationId, row.name.trim());
        }
      }
      for (const row of rows) {
        if (row.removed) continue;
        const name = row.name.trim();
        if (!name) continue;
        if (row.secret) {
          if (!row.value.trim()) continue; // blank secret keeps existing value
          const res = await window.electron.automation.env.set(automationId, name, row.value, true);
          if ("error" in (res ?? {})) {
            setError((res as { error: string }).error);
            return;
          }
          continue;
        }
        // Non-secret row: purge any keychain secret that may linger under the
        // same name (e.g. a secret→plain toggle), then either write the plain
        // value or remove the var entirely when the value is blank — a plain
        // "" is dropped at run time anyway, so persisting it is a silent no-op.
        if (row.originalSecret || row.value === "") {
          await window.electron.automation.env.delete(automationId, name);
        }
        if (row.value === "") continue;
        const res = await window.electron.automation.env.set(automationId, name, row.value, false);
        if ("error" in (res ?? {})) {
          setError((res as { error: string }).error);
          return;
        }
      }
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const secretCount = useMemo(() => visible.filter((r) => r.secret).length, [visible]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          Environment {visible.length > 0 && `(${visible.length}${secretCount ? ` · ${secretCount} secret` : ""})`}
        </span>
        <div className="flex items-center gap-1">
          <Tooltip content="Reload">
            <Button variant="ghost" size="xs" onClick={() => void load()} disabled={loading || saving}>
              <RefreshCw size={11} className={cn(loading && "animate-spin")} />
            </Button>
          </Tooltip>
          <Button variant="ghost" size="xs" onClick={addRow} disabled={saving}>
            <Plus size={11} /> Add
          </Button>
          <Button variant="accent" size="xs" onClick={() => void save()} disabled={saving || visible.length === 0}>
            Save env
          </Button>
        </div>
      </div>

      <p className="text-[0.714rem] text-[var(--text-tertiary)]">
        Env vars are injected into scripts at run time. Secrets are stored in your OS keychain and never leave the machine.
      </p>

      {error && (
        <div className="rounded-md border border-[var(--danger)]/40 bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-2.5 py-1.5 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-[var(--text-tertiary)]">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-[var(--text-tertiary)]">
          No env vars yet. Add one (e.g. an API key) for your scripts to read via <code className="font-mono">process.env</code>.
        </p>
      ) : (
        <div className="space-y-1.5">
          {visible.map((row) => (
            <div key={row.key} className="flex items-center gap-1.5">
              <Input
                value={row.name}
                onChange={(e) => updateRow(row.key, { name: e.target.value })}
                placeholder="VAR_NAME"
                className="w-40 shrink-0 font-mono text-[0.714rem]"
                spellCheck={false}
              />
              <Input
                type={row.secret && !reveal ? "password" : "text"}
                value={row.value}
                onChange={(e) => updateRow(row.key, { value: e.target.value })}
                placeholder={row.secret ? (row.set ? "•••••••• (leave blank to keep)" : "Secret value") : "Value"}
                className="flex-1 min-w-0 text-[0.714rem]"
                spellCheck={false}
              />
              <Tooltip content={row.secret ? "Secret — stored in OS keychain" : "Not secret — plain value"}>
                <button
                  type="button"
                  onClick={() => updateRow(row.key, { secret: !row.secret })}
                  className={cn(
                    "flex items-center gap-1 shrink-0 rounded px-1.5 py-1 text-[0.65rem] uppercase tracking-wide border transition-colors",
                    row.secret
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                  )}
                >
                  {row.secret ? <KeyRound size={10} /> : "plain"}
                </button>
              </Tooltip>
              {row.secret && (
                <Tooltip content={reveal ? "Hide secret values" : "Reveal secret values"}>
                  <button
                    type="button"
                    onClick={() => setReveal((v) => !v)}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] shrink-0"
                  >
                    {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </Tooltip>
              )}
              <Tooltip content="Remove">
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  className="text-[var(--text-tertiary)] hover:text-[var(--danger)] shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </Tooltip>
            </div>
          ))}
          {rows.some((r) => r.removed) && (
            <button
              type="button"
              onClick={() => setRows((prev) => prev.filter((r) => !r.removed))}
              className="text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1"
            >
              <X size={11} /> Undo removals
            </button>
          )}
        </div>
      )}
    </div>
  );
}
