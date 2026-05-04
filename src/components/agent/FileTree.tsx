"use client";

/**
 * FileTree — directory listing for the Agent view left pane.
 *
 * Reads the project's code_directory via agent:readDir IPC.
 * Expand/collapse directories on click. File click sets activeEditorFile.
 */

import { useState, useEffect, useCallback } from "react";
import {
  ChevronRight, ChevronDown, FolderOpen, Folder,
  FileText, FileCode, FileJson, Settings, AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { Project } from "@/types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DirEntry {
  name: string;
  type: "file" | "dir";
  path: string;
}

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  activePath: string | null;
  onFileClick: (path: string) => void;
}

// ── File icon helper ──────────────────────────────────────────────────────────

function FileIcon({ name, size = 12 }: { name: string; size?: number }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["json", "jsonc"].includes(ext)) return <FileJson size={size} />;
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "rb", "java", "c", "cpp", "cs"].includes(ext))
    return <FileCode size={size} />;
  if (["yml", "yaml", "toml", "env", "ini", "cfg"].includes(ext))
    return <Settings size={size} />;
  return <FileText size={size} />;
}

// ── Single tree node ──────────────────────────────────────────────────────────

function TreeNode({ entry, depth, activePath, onFileClick }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (entry.type !== "dir") return;
    if (!expanded && children === null) {
      setLoading(true);
      try {
        const result = await window.electron?.agent.readDir(entry.path);
        if (result && "data" in result) setChildren(result.data as DirEntry[]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((v) => !v);
  }, [entry, expanded, children]);

  const isActive = activePath === entry.path;
  const indent = depth * 12;

  if (entry.type === "dir") {
    return (
      <div>
        <button
          onClick={toggle}
          className={cn(
            "flex items-center gap-1 w-full px-2 py-0.5 text-[0.786rem] transition-colors text-left rounded-sm",
            "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
          )}
          style={{ paddingLeft: `${indent + 8}px` }}
        >
          {expanded
            ? <ChevronDown size={10} className="flex-shrink-0 text-[var(--text-tertiary)]" />
            : <ChevronRight size={10} className="flex-shrink-0 text-[var(--text-tertiary)]" />}
          <FolderOpen size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate font-medium">{entry.name}</span>
          {loading && <span className="ml-auto text-[0.714rem] text-[var(--text-tertiary)]">…</span>}
        </button>
        {expanded && children && (
          <div>
            {children.map((child) => (
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                activePath={activePath}
                onFileClick={onFileClick}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onFileClick(entry.path)}
      className={cn(
        "flex items-center gap-1.5 w-full px-2 py-0.5 text-[0.786rem] transition-colors text-left rounded-sm",
        isActive
          ? "text-[var(--accent)] bg-[var(--accent-dim)]"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
      )}
      style={{ paddingLeft: `${indent + 20}px` }}
    >
      <FileIcon name={entry.name} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

// ── FileTree root ─────────────────────────────────────────────────────────────

interface FileTreeProps {
  project: Project | null;
}

export function FileTree({ project }: FileTreeProps) {
  const { activeEditorFile, setActiveEditorFile, setView } = useCairnStore();
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const codeDirectory = project?.codeDirectory ?? null;

  useEffect(() => {
    if (!codeDirectory) { setRootEntries(null); return; }
    setError(null);
    window.electron?.agent.readDir(codeDirectory)
      .then((result: unknown) => {
        const r = result as { data?: DirEntry[]; error?: string };
        if (r && "data" in r) setRootEntries(r.data ?? []);
        else setError(r?.error ?? "Failed to read directory");
      })
      .catch((e: unknown) => setError(String(e)));
  }, [codeDirectory]);

  if (!codeDirectory) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4 text-center">
        <Folder size={24} className="text-[var(--text-tertiary)]" />
        <p className="text-xs text-[var(--text-tertiary)]">No code directory set</p>
        <button
          onClick={() => setView("settings")}
          className="text-xs text-[var(--accent)] hover:underline"
        >
          Configure in Settings
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4 text-center">
        <AlertCircle size={20} className="text-[var(--danger)]" />
        <p className="text-xs text-[var(--danger)]">{error}</p>
      </div>
    );
  }

  if (!rootEntries) {
    return (
      <div className="flex items-center justify-center flex-1">
        <span className="text-xs text-[var(--text-tertiary)]">Loading…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-subtle)] flex-shrink-0">
        <FolderOpen size={12} className="text-[var(--text-tertiary)]" />
        <span className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] truncate">
          {codeDirectory.split("/").pop() ?? "Files"}
        </span>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {rootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            activePath={activeEditorFile}
            onFileClick={setActiveEditorFile}
          />
        ))}
        {rootEntries.length === 0 && (
          <p className="text-xs text-[var(--text-tertiary)] px-3 py-4 text-center">
            Directory is empty
          </p>
        )}
      </div>
    </div>
  );
}
