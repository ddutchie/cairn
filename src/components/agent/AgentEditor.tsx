"use client";

/**
 * AgentEditor — CodeMirror 6 inline file editor for the Agent view centre pane.
 *
 * - Loads file content via agent:readFile IPC when activeEditorFile changes.
 * - Language detected from file extension via @codemirror/language-data.
 * - Cmd/Ctrl+S saves via agent:writeFile IPC.
 * - Dirty indicator in the header bar.
 * - "Diff" sub-tab toggle swaps editor for DiffViewer for the active session.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Save, GitCompare, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { DiffViewer } from "./DiffViewer";

// ── CM6 theme (mirrors markdown-editor.tsx pattern) ──────────────────────────

function buildTheme() {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "0.875rem",
      fontFamily: "var(--font-mono, ui-monospace, 'Cascadia Code', monospace)",
      background: "var(--background)",
      color: "var(--text-primary)",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "1.6",
      overflow: "auto",
      padding: "16px",
    },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    ".cm-selectionBackground": { background: "var(--accent-dim) !important" },
    "&.cm-focused .cm-selectionBackground": { background: "var(--accent-dim) !important" },
    ".cm-gutters": {
      background: "var(--surface)",
      borderRight: "1px solid var(--border-subtle)",
      color: "var(--text-tertiary)",
      minWidth: "2.5rem",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px" },
    ".cm-activeLine": { background: "color-mix(in srgb, var(--accent) 5%, transparent)" },
    ".cm-activeLineGutter": { background: "color-mix(in srgb, var(--accent) 8%, transparent)" },
  });
}

// ── AgentEditor ───────────────────────────────────────────────────────────────

type SubTab = "editor" | "diff";

export function AgentEditor() {
  const { activeEditorFile, activeSessionId, terminalSessions } = useCairnStore();
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [subTab, setSubTab] = useState<SubTab>("editor");
  const [loadError, setLoadError] = useState<string | null>(null);

  const activeSession = terminalSessions.find((s) => s.sessionId === activeSessionId) ?? null;
  const fileName = activeEditorFile?.split("/").pop() ?? null;

  // ── Load file into CM6 when activeEditorFile changes ─────────────────────
  useEffect(() => {
    if (!activeEditorFile || !window.electron) return;
    setLoadError(null);
    setDirty(false);

    window.electron.agent.readFile(activeEditorFile)
      .then(async (result: unknown) => {
        const r = result as { data?: string; error?: string };
        const content = r && "data" in r ? (r.data ?? "") : "";
        if ("error" in (r ?? {})) { setLoadError((r as {error: string}).error); return; }

        // Detect language
        const lang = await LanguageDescription.matchFilename(languages, activeEditorFile)
          ?.load()
          .catch(() => null);

        const extensions = [
          buildTheme(),
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            {
              key: "Mod-s",
              run: (view) => { handleSave(view.state.doc.toString()); return true; },
            },
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setDirty(true);
          }),
          ...(lang ? [lang] : []),
        ];

        const state = EditorState.create({ doc: content, extensions });

        if (viewRef.current) {
          viewRef.current.destroy();
        }
        if (editorRef.current) {
          viewRef.current = new EditorView({ state, parent: editorRef.current });
        }
      })
      .catch((e: unknown) => setLoadError(String(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditorFile]);

  // Destroy CM6 on unmount
  useEffect(() => () => { viewRef.current?.destroy(); }, []);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async (content: string) => {
    if (!activeEditorFile || !window.electron) return;
    setSaving(true);
    try {
      await window.electron.agent.writeFile(activeEditorFile, content);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [activeEditorFile]);

  const onSaveClick = useCallback(() => {
    const content = viewRef.current?.state.doc.toString() ?? "";
    handleSave(content);
  }, [handleSave]);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!activeEditorFile) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center p-8">
        <FileCode size={28} className="text-[var(--text-tertiary)]" />
        <p className="text-sm text-[var(--text-tertiary)]">Select a file to edit</p>
        <p className="text-xs text-[var(--text-tertiary)]">Click a file in the tree on the left</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface)]">
        <span className="text-[0.786rem] font-medium text-[var(--text-primary)] truncate flex-1">
          {fileName}
          {dirty && <span className="ml-1 text-[var(--text-tertiary)]">•</span>}
        </span>

        {/* Sub-tab toggle */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setSubTab("editor")}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded text-[0.714rem] transition-colors",
              subTab === "editor"
                ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            )}
          >
            <FileCode size={11} />
            Editor
          </button>
          {activeSession && (
            <button
              onClick={() => setSubTab("diff")}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded text-[0.714rem] transition-colors",
                subTab === "diff"
                  ? "text-[var(--text-primary)] bg-[var(--surface-2)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              )}
            >
              <GitCompare size={11} />
              Diff
            </button>
          )}
        </div>

        {/* Save button */}
        {subTab === "editor" && (
          <button
            onClick={onSaveClick}
            disabled={!dirty || saving}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded text-[0.714rem] transition-colors",
              dirty
                ? "text-[var(--accent)] hover:bg-[var(--accent-dim)]"
                : "text-[var(--text-tertiary)]"
            )}
            title="Save (⌘S)"
          >
            <Save size={11} />
            {saved ? "Saved" : saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {/* Load error */}
      {loadError && (
        <div className="px-4 py-2 text-xs text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]">
          {loadError}
        </div>
      )}

      {/* Editor / Diff — CSS-hide editor when diff is active so CM6 stays mounted */}
      <div className={cn("flex-1 min-h-0 overflow-hidden", subTab !== "editor" && "hidden")}>
        <div ref={editorRef} className="h-full" />
      </div>

      {subTab === "diff" && activeSession && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <DiffViewer sessionId={activeSession.sessionId} />
        </div>
      )}
    </div>
  );
}
