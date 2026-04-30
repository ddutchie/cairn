"use client";

import React, { useState, useEffect, useRef } from "react";
import { Wand2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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

  useEffect(() => { setTimeout(() => titleRef.current?.focus(), 50); }, []);

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
    <Dialog open onOpenChange={(o) => { if (!o && !loading) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 size={14} className="text-[var(--accent)]" />
            Generate PRD
          </DialogTitle>
        </DialogHeader>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)]">PRD title</label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) e.currentTarget.blur(); }}
              placeholder="e.g. PRD — User Authentication"
              disabled={loading}
              className="w-full px-3 py-2 text-sm rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Describe what you want to build</label>
            <textarea
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder="e.g. I want to build a login system with email/password and Google OAuth…"
              disabled={loading}
              rows={5}
              className="w-full px-3 py-2 text-sm rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none disabled:opacity-50"
            />
          </div>
          {error && (
            <p className="text-xs text-[var(--danger)] bg-[var(--danger)]/10 rounded-md px-3 py-2">{error}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
            <Button
              variant="accent" size="sm"
              onClick={handleGenerate}
              disabled={loading || !title.trim() || !requirements.trim()}
            >
              {loading
                ? <><Loader2 size={12} className="animate-spin" />Generating…</>
                : <><Wand2 size={12} />Generate PRD</>}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
