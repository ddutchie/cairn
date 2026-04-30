"use client";

import React, { useState, useEffect, useRef } from "react";
import { Wand2, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

interface PrdModalProps {
  projectId: string;
  generatePrd: (projectId: string, title: string, requirements: string) => Promise<{ error: string } | void>;
  onClose: () => void;
}

export function PrdModal({ projectId, generatePrd, onClose }: PrdModalProps) {
  const [title, setTitle] = useState("");
  const [requirements, setRequirements] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  async function handleGenerate() {
    if (!title.trim() || !requirements.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await generatePrd(projectId, title.trim(), requirements.trim());
      if (result?.error) setError(result.error);
      else onClose();
    } catch (err) {
      setError((err as Error).message ?? "Failed to generate PRD");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 p-5 flex flex-col gap-4"
        onKeyDown={(e) => e.key === "Escape" && !loading && onClose()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wand2 size={15} className="text-[var(--accent)]" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">Generate PRD</span>
          </div>
          <Tooltip content="Close">
            <button onClick={onClose} disabled={loading}
              className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-40">
              <X size={14} />
            </button>
          </Tooltip>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--text-secondary)]">PRD title</label>
          <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. PRD — User Authentication" disabled={loading}
            className="w-full px-3 py-2 text-sm rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50" />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--text-secondary)]">Describe what you want to build</label>
          <textarea value={requirements} onChange={(e) => setRequirements(e.target.value)}
            placeholder="e.g. I want to build a login system with email/password and Google OAuth…"
            disabled={loading} rows={5}
            className="w-full px-3 py-2 text-sm rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none disabled:opacity-50" />
        </div>

        {error && <p className="text-xs text-red-400 bg-red-400/10 rounded-md px-3 py-2">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant="accent" size="sm" onClick={handleGenerate} disabled={loading || !title.trim() || !requirements.trim()}>
            {loading ? <><Loader2 size={12} className="animate-spin" />Generating…</> : <><Wand2 size={12} />Generate PRD</>}
          </Button>
        </div>
      </div>
    </div>
  );
}
