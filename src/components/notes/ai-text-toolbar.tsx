"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Wand2, RefreshCw, AlignLeft, Expand, SpellCheck, MessageSquare, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type AITextAction =
  | "rephrase"
  | "summarize"
  | "expand"
  | "fix_grammar"
  | "change_tone"
  | "custom";

interface AITextToolbarProps {
  position: { top: number; left: number };
  onAction: (action: AITextAction, customPrompt?: string) => void;
  loading: boolean;
  onDismiss: () => void;
}

const ACTIONS: { id: AITextAction; label: string; icon: React.ReactNode }[] = [
  { id: "rephrase",    label: "Rephrase",    icon: <RefreshCw size={11} /> },
  { id: "summarize",   label: "Summarize",   icon: <AlignLeft size={11} /> },
  { id: "expand",      label: "Expand",      icon: <Expand size={11} /> },
  { id: "fix_grammar", label: "Fix grammar", icon: <SpellCheck size={11} /> },
  { id: "change_tone", label: "Change tone", icon: <MessageSquare size={11} /> },
  { id: "custom",      label: "Custom…",     icon: <Wand2 size={11} /> },
];

export function AITextToolbar({ position, onAction, loading, onDismiss }: AITextToolbarProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showCustom) inputRef.current?.focus();
  }, [showCustom]);

  function handleAction(action: AITextAction) {
    if (action === "custom") {
      setShowCustom(true);
      return;
    }
    onAction(action);
  }

  function handleCustomSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customPrompt.trim()) return;
    onAction("custom", customPrompt.trim());
    setCustomPrompt("");
    setShowCustom(false);
  }

  const toolbar = (
    <div
      ref={toolbarRef}
      data-ai-toolbar
      className="fixed z-50 animate-fade-in"
      style={{
        top: 0,
        left: 0,
        transform: `translate(calc(${position.left}px - 50%), calc(${position.top}px - 100%))`,
      }}
      // Prevent mousedown from bubbling up and dismissing the toolbar
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-1">
        {/* Main toolbar */}
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg shadow-black/20 p-1">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-[var(--text-tertiary)]">
              <Loader2 size={11} className="animate-spin" />
              <span>Writing…</span>
            </div>
          ) : (
            <>
              {ACTIONS.map((action) => (
                <button
                  key={action.id}
                  onClick={() => handleAction(action.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors whitespace-nowrap",
                    "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]",
                    showCustom && action.id === "custom" && "bg-[var(--surface-2)] text-[var(--text-primary)]"
                  )}
                >
                  {action.icon}
                  {action.label}
                </button>
              ))}
              <div className="w-px h-4 bg-[var(--border)] mx-0.5" />
              <button
                onClick={onDismiss}
                className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <X size={11} />
              </button>
            </>
          )}
        </div>

        {/* Custom prompt input */}
        {showCustom && !loading && (
          <form
            onSubmit={handleCustomSubmit}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg shadow-black/20 p-1.5"
          >
            <Wand2 size={11} className="text-[var(--text-tertiary)] flex-shrink-0 ml-1" />
            <input
              ref={inputRef}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setShowCustom(false), setCustomPrompt(""))}
              placeholder="Describe what to do with the text…"
              className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none min-w-48"
            />
            <button
              type="submit"
              disabled={!customPrompt.trim()}
              className="px-2 py-0.5 rounded text-[11px] bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              Apply
            </button>
          </form>
        )}
      </div>
    </div>
  );

  return createPortal(toolbar, document.body);
}

export function buildAIActionPrompt(action: AITextAction, selectedText: string, customPrompt?: string): string {
  const base = `You are an AI writing assistant embedded in a note editor. The user has selected the following text:\n\n"${selectedText}"\n\n`;
  switch (action) {
    case "rephrase":     return base + "Rephrase this text to say the same thing in a different, clearer way. Return only the rewritten text, no commentary.";
    case "summarize":    return base + "Summarize this text concisely. Return only the summary, no commentary.";
    case "expand":       return base + "Expand this text with more detail and depth. Return only the expanded text, no commentary.";
    case "fix_grammar":  return base + "Fix any grammar, spelling, and punctuation errors in this text. Return only the corrected text, no commentary.";
    case "change_tone":  return base + "Rewrite this text in a more professional and polished tone. Return only the rewritten text, no commentary.";
    case "custom":       return base + `${customPrompt}. Return only the resulting text, no commentary.`;
  }
}
