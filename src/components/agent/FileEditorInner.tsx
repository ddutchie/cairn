"use client";

/**
 * FileEditorInner — mounts a single CM6 editor instance for one file path.
 * CSS-hidden (not unmounted) when inactive to preserve scroll/undo history.
 */

import { useEffect, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { buildTheme, buildHighlightStyle, lineNumbers } from "./editorTheme";

export interface FileEditorInnerProps {
  filePath: string;
  isActive: boolean;
  isDark: boolean;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onSave: (path: string, content: string) => void;
}

export function FileEditorInner({ filePath, isActive, isDark, onDirtyChange, onSave }: FileEditorInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pathRef = useRef(filePath);
  pathRef.current = filePath;

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!window.electron) return;

    (window.electron.agent.readFile(filePath) as Promise<string>)
      .then(async (content: string) => {
        const lang = await LanguageDescription.matchFilename(languages, filePath)
          ?.load().catch(() => null);

        const state = EditorState.create({
          doc: content,
          extensions: [
            buildTheme(),
            buildHighlightStyle(isDark),
            lineNumbers(),
            history(),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              {
                key: "Mod-s",
                run: (view) => {
                  onSaveRef.current(pathRef.current, view.state.doc.toString());
                  return true;
                },
              },
            ]),
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) onDirtyChange(pathRef.current, true);
            }),
            ...(lang ? [lang] : []),
          ],
        });

        viewRef.current?.destroy();
        if (containerRef.current) {
          viewRef.current = new EditorView({ state, parent: containerRef.current });
        }
      })
      .catch((e: unknown) => setLoadError(String(e)));

    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, isDark]);

  // Focus when active
  useEffect(() => {
    if (isActive) viewRef.current?.focus();
  }, [isActive]);

  // Save button via custom event
  useEffect(() => {
    function handler(e: Event) {
      const path = (e as CustomEvent<string>).detail;
      if (path !== filePath) return;
      const content = viewRef.current?.state.doc.toString() ?? "";
      onSaveRef.current(filePath, content);
    }
    document.addEventListener("agent-editor-save", handler);
    return () => document.removeEventListener("agent-editor-save", handler);
  }, [filePath]);

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {loadError && (
        <div className="px-4 py-2 text-xs text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] flex-shrink-0">
          {loadError}
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}
