"use client";

/**
 * PersonalityPicker — a compact "how should the assistant talk?" control shown
 * next to the provider · model picker in the chat input. Picks the active
 * personality for the session: a set of behavioral rules appended to the system
 * prompt as a style layer. "Default" = the base Cairn assistant, no layer.
 *
 * Installed personalities live globally on aiConfig (community + custom). From
 * here the user can select, remove, create a custom one, or browse + install
 * from the cairn-community catalog.
 */

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Sparkles, ChevronDown, Plus, Download, Trash2, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { BrowsePersonalitiesModal } from "@/components/chat/BrowsePersonalitiesModal";

export interface PersonalityPickerProps {
  disabled?: boolean;
  align?: "start" | "center" | "end";
  /** Density for the trigger chip. "xs" = input footer; "sm" = headers. */
  size?: "xs" | "sm";
  className?: string;
}

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-[0.714rem] px-2.5 py-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]";

export function PersonalityPicker({
  disabled,
  align = "end",
  size = "xs",
  className,
}: PersonalityPickerProps) {
  const { installedPersonalities, personalityId, setPersonality, removePersonality, createCustomPersonality } =
    useCairnStore(
      useShallow((s) => ({
        installedPersonalities: s.aiConfig.installedPersonalities,
        personalityId: s.aiConfig.personalityId,
        setPersonality: s.setPersonality,
        removePersonality: s.removePersonality,
        createCustomPersonality: s.createCustomPersonality,
      })),
    );

  // NOTE: the `?? []` fallback lives OUTSIDE the selector — a fresh array
  // reference inside the selector would break useShallow's snapshot caching
  // (React's "getSnapshot should be cached" infinite-loop guard).
  const personalityList = installedPersonalities ?? [];

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");

  const active = personalityList.find((p) => p.id === personalityId) ?? null;
  const triggerPad = size === "xs" ? "px-1.5 py-0.5 text-[0.643rem]" : "px-2 py-1 text-[0.714rem]";

  const select = (id: string | null) => {
    setPersonality(id);
    setOpen(false);
  };

  const submitCustom = () => {
    if (!name.trim() || !prompt.trim()) return;
    const id = createCustomPersonality({
      name: name.trim(),
      description: description.trim() || undefined,
      prompt: prompt.trim(),
    });
    setPersonality(id);
    setCreating(false);
    setName("");
    setDescription("");
    setPrompt("");
  };

  const resetForm = () => {
    setCreating(false);
    setName("");
    setDescription("");
    setPrompt("");
  };

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tooltip content="Chat personality" side="top">
          <Popover.Trigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Chat personality"
              title={active ? `${active.name} personality` : "No personality selected"}
              className={cn(
                "flex items-center gap-1 rounded-md border border-[var(--border)] text-[var(--text-secondary)] transition-colors",
                "hover:bg-[var(--surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50",
                triggerPad,
                className,
              )}
            >
              <Sparkles size={11} className={cn("shrink-0", active?.brandColor ? "" : "text-[var(--text-tertiary)]")} style={active?.brandColor ? { color: active.brandColor } : undefined} />
              <span className="max-w-[7rem] truncate">
                {active ? active.name : "None"}
              </span>
              <ChevronDown size={11} className="text-[var(--text-tertiary)] shrink-0" />
            </button>
          </Popover.Trigger>
        </Tooltip>

        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align={align}
            sideOffset={6}
            className="z-50 w-80 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-3 space-y-3 animate-fade-in focus:outline-none"
          >
            <div className="flex items-center justify-between">
              <div className="text-[0.643rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                Chat · personality
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              >
                <X size={13} />
              </button>
            </div>

            {/* None — the base Cairn assistant, no personality layer */}
            <div className="space-y-1">
              <span className="text-[0.714rem] text-[var(--text-secondary)]">Active</span>
              <button
                type="button"
                onClick={() => select(null)}
                className={cn(
                  "flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-left text-[0.714rem] transition-colors",
                  !active
                    ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
                )}
              >
                <Sparkles size={12} className="text-[var(--text-tertiary)] shrink-0" />
                <span className="truncate flex-1">None — no personality</span>
                {!active && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0" />}
              </button>
            </div>

            {/* Installed personalities */}
            <div className="space-y-1">
              <span className="text-[0.714rem] text-[var(--text-secondary)]">Installed</span>
              <div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto pr-0.5">
                {personalityList.length === 0 ? (
                  <p className="text-[0.643rem] text-[var(--text-tertiary)] px-1">
                    None yet — create your own below or browse the community catalog.
                  </p>
                ) : (
                  personalityList.map((p) => {
                    const isActive = p.id === personalityId;
                    return (
                      <div
                        key={p.id}
                        className={cn(
                          "group flex items-start gap-1.5 px-2 py-1.5 rounded-md text-left text-[0.714rem] transition-colors",
                          isActive
                            ? "bg-[var(--accent-dim)]"
                            : "hover:bg-[var(--surface-2)]",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => select(p.id)}
                          className="flex items-start gap-1.5 flex-1 min-w-0 text-left"
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0"
                            style={{ background: p.brandColor ?? "var(--text-tertiary)" }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className={cn("flex items-center gap-1.5", isActive ? "text-[var(--accent)]" : "text-[var(--text-secondary)]")}>
                              <span className="truncate font-medium">{p.name}</span>
                              {p.source === "custom" && (
                                <span className="text-[0.6rem] text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 leading-3">custom</span>
                              )}
                            </span>
                            <span className="block text-[0.6rem] text-[var(--text-tertiary)] mt-0.5 line-clamp-2 whitespace-pre-wrap">
                              {p.prompt}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => removePersonality(p.id)}
                          title="Remove"
                          className="text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 hover:text-[var(--danger)] transition-opacity mt-0.5 flex-shrink-0"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Create your own */}
            {creating ? (
              <div className="space-y-2 border-t border-[var(--border)] pt-2">
                <div className="text-[0.643rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  New personality
                </div>
                <input
                  className={inputCls}
                  placeholder="Name (e.g. Concise)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  className={inputCls}
                  placeholder="Description (optional)"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <textarea
                  className={cn(inputCls, "resize-none min-h-20")}
                  placeholder="Behavioral rules appended to the system prompt. Write rules, not a 'You are …' identity."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
                  <Button size="sm" disabled={!name.trim() || !prompt.trim()} onClick={submitCustom}>
                    Create
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-left text-[0.714rem] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
              >
                <Plus size={12} />
                Create your own
              </button>
            )}

            {/* Browse community */}
            <button
              type="button"
              onClick={() => setBrowsing(true)}
              className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-left text-[0.714rem] text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors"
            >
              <Download size={12} />
              Browse Community Personalities…
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {browsing && <BrowsePersonalitiesModal onClose={() => setBrowsing(false)} />}
    </>
  );
}
