"use client";

/**
 * MigrationModal — shown on app startup when workspace migrations are pending.
 *
 * Blocks app usage until all migrations are completed (or none are needed).
 * Extensible for future migrations — each migration shows title, description,
 * and a progress bar while running.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Loader2, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";

interface MigrationStatus {
  id: string;
  title: string;
  description: string;
  needed: boolean;
}

interface MigrationProgress {
  migrationId: string;
  pct: number;
  msg: string;
}

type Phase = "pending" | "running" | "done" | "error" | "none";

export function MigrationModal() {
  // Start as "none" so the modal is hidden until we confirm migrations are needed.
  // This avoids calling setState synchronously inside the effect body.
  const [phase, setPhase] = useState<Phase>("none");
  const [migrations, setMigrations] = useState<MigrationStatus[]>([]);
  const [currentMigration, setCurrentMigration] = useState<string | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Check for pending migrations on mount
  useEffect(() => {
    const electron = window.electron;
    if (!electron?.checkMigrations) return; // stay "none"

    electron.checkMigrations().then((statuses) => {
      const pending = statuses.filter((m) => m.needed);
      if (pending.length > 0) {
        setMigrations(pending);
        setPhase("pending");
      }
      // if empty, phase stays "none" — modal remains hidden
    }).catch(() => {
      // on error, stay hidden rather than blocking the app
    });
  }, []);

  // Listen for progress events
  useEffect(() => {
    const electron = window.electron;
    if (!electron?.onMigrationProgress) return;
    const unsub = electron.onMigrationProgress((e) => {
      setProgress(e);
    });
    return () => { unsub(); };
  }, []);

  const handleRunAll = useCallback(async () => {
    const electron = window.electron;
    if (!electron?.runMigration) return;

    setPhase("running");

    for (const m of migrations) {
      setCurrentMigration(m.id);
      setProgress({ migrationId: m.id, pct: 0, msg: "Starting..." });
      try {
        await electron.runMigration(m.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
        return;
      }
    }

    setPhase("done");
  }, [migrations]);

  // Don't render anything until migrations are confirmed to be needed
  if (phase === "none") return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center"
         style={{ background: "color-mix(in srgb, var(--background) 85%, transparent)", backdropFilter: "blur(8px)" }}>
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--border)] shadow-2xl overflow-hidden"
        style={{ background: "var(--surface)" }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            {phase === "done" ? (
              <CheckCircle2 size={18} className="text-[var(--success)]" />
            ) : phase === "error" ? (
              <AlertTriangle size={18} className="text-[var(--warning)]" />
            ) : (
              <ArrowRight size={18} className="text-[var(--accent)]" />
            )}
            Workspace Migration
          </h2>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {phase === "pending" && "Your workspace needs to be updated for compatibility."}
            {phase === "running" && "Migration in progress — please don't close the app."}
            {phase === "done" && "All migrations completed successfully."}
            {phase === "error" && "An error occurred during migration."}
          </p>
        </div>

        {/* Migration List */}
        <div className="px-6 py-4 space-y-3">
          {migrations.map((m) => {
            const isActive = currentMigration === m.id;
            const isDone = phase === "done" || (phase === "running" && currentMigration !== m.id && migrations.indexOf(m) < migrations.findIndex((x) => x.id === currentMigration));
            return (
              <div key={m.id} className="rounded-lg border border-[var(--border)] p-4" style={{ background: "var(--surface-2)" }}>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {isDone ? (
                      <CheckCircle2 size={16} className="text-[var(--success)]" />
                    ) : isActive && phase === "running" ? (
                      <Loader2 size={16} className="animate-spin text-[var(--accent)]" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border-2 border-[var(--border)]" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{m.title}</p>
                    <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{m.description}</p>
                    {/* Progress bar */}
                    {isActive && progress && phase === "running" && (
                      <div className="mt-3">
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{ width: `${progress.pct}%`, background: "var(--accent)" }}
                          />
                        </div>
                        <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1">{progress.msg}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Error message */}
          {phase === "error" && error && (
            <div className="rounded-lg p-3 text-sm text-[var(--error)]" style={{ background: "color-mix(in srgb, var(--error) 10%, transparent)" }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-2">
          {phase === "pending" && (
            <button
              onClick={handleRunAll}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
              style={{ background: "var(--accent)" }}
            >
              Start Migration
            </button>
          )}
          {phase === "done" && (
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
              style={{ background: "var(--accent)" }}
            >
              Continue
            </button>
          )}
          {phase === "error" && (
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--text-primary)] transition-colors"
              style={{ background: "var(--surface-2)" }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
