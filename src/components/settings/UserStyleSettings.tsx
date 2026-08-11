"use client";

/**
 * Settings → Writing Style — the user's persona + full style guide + condensed
 * cheat sheet. Generated via the guided wizard and consumed by the
 * get_user_writing_style tool (chat + agent) so AI-drafted content sounds like
 * the user.
 */

import { useState, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { PenLine, Sparkles, Trash2, Loader2, RefreshCw } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./shared";
import { UserStyleWizardModal } from "./UserStyleWizardModal";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function UserStyleSettings() {
  const { userStyle, fetchUserStyle, clearUserStyle, saveUserStyle } = useCairnStore(
    useShallow((s) => ({
      userStyle: s.userStyle,
      fetchUserStyle: s.fetchUserStyle,
      clearUserStyle: s.clearUserStyle,
      saveUserStyle: s.saveUserStyle,
    })),
  );

  const [wizardMode, setWizardMode] = useState<"guided" | "paste" | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);

  useEffect(() => {
    void fetchUserStyle();
  }, [fetchUserStyle]);

  const configured = !!userStyle && userStyle.source !== "none" && !!(userStyle.fullGuide || userStyle.cheatsheet);

  const regenerateCheatsheet = async () => {
    if (!userStyle?.fullGuide) return;
    if (!window.electron?.generateUserStyle) {
      setRegenerateError("AI generation isn't available in this build.");
      return;
    }
    setRegenerating(true);
    setRegenerateError(null);
    try {
      const res = await window.electron.generateUserStyle("cheatsheet", {
        persona: userStyle.persona ?? {},
        samples: [],
        answers: [],
        fullGuide: userStyle.fullGuide,
      });
      if (res?.markdown) {
        await saveUserStyle({
          persona: userStyle.persona ?? undefined,
          cheatsheet: res.markdown,
          source: userStyle.source,
        });
      } else {
        setRegenerateError("Generation returned no output — try again.");
      }
    } catch (err) {
      setRegenerateError(err instanceof Error ? err.message : "Couldn't regenerate the cheat sheet.");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <>
      <SettingsGroup
        title="Writing Style"
        description="Your persona and how you write, so AI-drafted content (emails, notes, PRDs, replies) sounds like you. Set up via a short guided session, then chat and the coding agent match your voice automatically."
      >
        {!configured ? (
          <>
            <SettingsRow
              label="Not set up yet"
              description="Run the guided setup: tell us who you are, paste a few real messages (or let us analyse your notes), and we generate a full style guide plus a condensed cheat sheet."
            >
              <span />
            </SettingsRow>
            <SettingsRow label="Get started">
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button
                  onClick={() => setWizardMode("guided")}
                  className="px-3 py-1.5 text-[0.714rem] rounded-md bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 transition-opacity flex items-center gap-1.5 cursor-pointer"
                >
                  <Sparkles size={12} /> Set up your writing style
                </button>
                <button
                  onClick={() => setWizardMode("paste")}
                  className="px-3 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <PenLine size={12} /> Paste a style directly
                </button>
              </div>
            </SettingsRow>
          </>
        ) : (
          <>
            {userStyle?.persona && (userStyle.persona.name || userStyle.persona.role) && (
              <SettingsRow label="Persona" description="Who the style guide belongs to.">
                <div className="text-[0.714rem] text-[var(--text-secondary)] text-right">
                  {[userStyle.persona.name, userStyle.persona.role].filter(Boolean).join(" · ")}
                </div>
              </SettingsRow>
            )}

            <SettingsRow
              label="Status"
              description="Last generated, and how it was produced. The tool returns the cheat sheet by default and the full guide on request."
            >
              <div className="text-[0.714rem] text-[var(--text-secondary)] text-right">
                {userStyle.source === "guided" ? "Guided setup" : userStyle.source === "analyzed" ? "Analysed" : "Manual"} · updated {formatDate(userStyle.updatedAt)}
              </div>
            </SettingsRow>

            {userStyle?.cheatsheet && (
              <SettingsRow label="Cheat sheet" description="Condensed one-page reference — what the tool returns by default.">
                <button
                  onClick={() => setCheatsheetOpen((v) => !v)}
                  className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  {cheatsheetOpen ? "Hide" : "Preview"}
                </button>
              </SettingsRow>
            )}
            {cheatsheetOpen && userStyle?.cheatsheet && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 max-h-72 overflow-y-auto">
                <NoteMarkdownPreview content={userStyle.cheatsheet} inline />
              </div>
            )}

            {userStyle?.fullGuide && (
              <SettingsRow label="Full guide" description="The complete style guide — requested with mode: 'full'.">
                <button
                  onClick={() => setFullOpen((v) => !v)}
                  className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  {fullOpen ? "Hide" : "Preview"}
                </button>
              </SettingsRow>
            )}
            {fullOpen && userStyle?.fullGuide && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 max-h-96 overflow-y-auto">
                <NoteMarkdownPreview content={userStyle.fullGuide} inline />
              </div>
            )}

            <SettingsRow label="Manage">
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button
                  onClick={() => setWizardMode("guided")}
                  className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <PenLine size={12} /> Edit / Regenerate
                </button>
                <button
                  onClick={() => setWizardMode("paste")}
                  className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <PenLine size={12} /> Paste style
                </button>
                <button
                  onClick={() => void regenerateCheatsheet()}
                  disabled={regenerating || !userStyle?.fullGuide}
                  className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                >
                  {regenerating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Regenerate cheat sheet
                </button>
                <button
                  onClick={() => void clearUserStyle()}
                  className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--danger)] hover:border-[var(--danger)] transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 size={12} /> Clear
                </button>
              </div>
              {regenerateError && (
                <p className="mt-2 text-[0.65rem] text-[var(--danger)]">{regenerateError}</p>
              )}
            </SettingsRow>
          </>
        )}

        <p className="text-[0.65rem] text-[var(--text-tertiary)] leading-relaxed">
          Chat and the coding agent can call <code className="font-mono">get_user_writing_style</code> to draft in your
          voice. They only fetch it when asked to write for you — it is never injected into every prompt.
        </p>
      </SettingsGroup>

      {wizardMode && (
        <UserStyleWizardModal
          onClose={() => setWizardMode(null)}
          existing={configured ? userStyle : null}
          initialPasteMode={wizardMode === "paste"}
        />
      )}
    </>
  );
}
