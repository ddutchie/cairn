"use client";

/**
 * FileTree — directory listing for the Agent view left pane.
 *
 * Reads the project's code_directory via agent:readDir IPC.
 * Expand/collapse directories on click. File click sets activeEditorFile.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronRight, ChevronDown, FolderOpen, Folder,
  FileText, FileCode, FileJson, Settings, AlertCircle, Search, X, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { modKey } from "@/components/layout/sidebar-utils";
import { useShallow } from "zustand/react/shallow";
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (entry.type !== "dir") return;
    // Re-read on every expand so externally-added/removed files show up — the
    // listing is otherwise cached in `children` for the node's lifetime.
    if (!expanded) {
      setLoading(true);
      setLoadError(null);
      try {
        const entries = await window.electron?.agent.readDir(entry.path) as DirEntry[] | undefined;
        if (entries) setChildren(entries);
      } catch (e) {
        setLoadError(String(e));
      } finally {
        setLoading(false);
      }
    }
    setExpanded((v) => !v);
  }, [entry, expanded]);

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
        {expanded && loadError && (
          <p className="px-3 py-1 text-[0.714rem] text-[var(--danger)]" style={{ paddingLeft: `${indent + 20}px` }}>
            {loadError}
          </p>
        )}
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

interface SearchResult {
  name: string;
  path: string;
  relativePath: string;
}

export function FileTree({ project }: FileTreeProps) {
  const { activeEditorFile, openEditorFile, updateProject } = useCairnStore(useShallow((s) => ({ activeEditorFile: s.activeEditorFile, openEditorFile: s.openEditorFile, updateProject: s.updateProject })));
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to force-remount tree nodes (clearing their cached `children`) on
  // a manual refresh — see refresh().
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [mod] = useState(() => modKey());

  // File search mode
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching]       = useState(false);
  const searchInputRef                  = useRef<HTMLInputElement>(null);

  const codeDirectory = project?.codeDirectory ?? null;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!codeDirectory) { setRootEntries(null); return; }
    setError(null);
    (window.electron?.agent.readDir(codeDirectory) as Promise<DirEntry[]> | undefined)
      ?.then((entries) => setRootEntries(entries))
      .catch((e: unknown) => setError(String(e)));
  }, [codeDirectory]);

  // Manual refresh: re-read the root listing and remount all nodes (bumping
  // refreshKey resets each TreeNode's cached `children`), picking up any files
  // added/removed externally since the tree was first read.
  const refresh = useCallback(async () => {
    if (!codeDirectory) return;
    setRefreshing(true);
    setError(null);
    try {
      const entries = await window.electron?.agent.readDir(codeDirectory) as DirEntry[] | undefined;
      if (entries) setRootEntries(entries);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, [codeDirectory]);

  // Auto-refresh when the Agent's GitView detects a change in the working-tree
  // file set (e.g. a new untracked file). Piggybacks on GitView's git-status
  // poll so the tree stays fresh without its own watcher.
  useEffect(() => {
    if (!codeDirectory) return;
    function onFilesChanged() { void refresh(); }
    window.addEventListener("cairn:agent-files-changed", onFilesChanged);
    return () => window.removeEventListener("cairn:agent-files-changed", onFilesChanged);
  }, [codeDirectory, refresh]);

  // ⌘⇧F / Ctrl+⇧F — toggle file search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const modPressed = e.metaKey || e.ctrlKey;
      // e.key is "F" (uppercase) when Shift is held on most platforms,
      // but normalise to lowercase to be safe across keyboard layouts.
      const key = e.key.toLowerCase();
      if (modPressed && e.shiftKey && key === "f") {
        e.preventDefault();  // always prevent — even if no codeDirectory, avoid native find-in-page
        e.stopPropagation();
        if (!codeDirectory) return;
        setSearchActive((v) => {
          const next = !v;
          if (!next) { setSearchQuery(""); setSearchResults([]); }
          return next;
        });
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (e.key === "Escape") {
        setSearchActive((v) => {
          if (v) { setSearchQuery(""); setSearchResults([]); }
          return false;
        });
      }
    }
    window.addEventListener("keydown", handleKeyDown, true); // capture phase — fires before page.tsx
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [codeDirectory]);

  // Run search whenever query changes
  useEffect(() => {
    if (!searchActive || !codeDirectory || !searchQuery.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchResults([]);
      return;
    }
    const q = searchQuery.trim();
    setSearching(true);
    (window.electron?.agent.searchFiles(codeDirectory, q) as Promise<SearchResult[]> | undefined)
      ?.then((results) => setSearchResults(results ?? []))
      .catch(() => setSearchResults([]))
      .finally(() => setSearching(false));
  }, [searchQuery, searchActive, codeDirectory]);

  async function handlePickCodeDir() {
    if (!project) return;
    const result = await window.electron?.agent.pickDirectory() as { data: string | null } | undefined;
    if (result?.data) updateProject(project.id, { codeDirectory: result.data });
  }

  if (!codeDirectory) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4 text-center">
        <Folder size={24} className="text-[var(--text-tertiary)]" />
        <p className="text-xs text-[var(--text-tertiary)]">No code directory set</p>
        <button
          onClick={handlePickCodeDir}
          className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline"
        >
          <FolderOpen size={11} />
          Choose folder
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
      {searchActive ? (
        <div className="flex items-center gap-1.5 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
          <Search size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files…"
            className="flex-1 min-w-0 bg-transparent text-[0.786rem] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
          />
          <button
            onClick={() => { setSearchActive(false); setSearchQuery(""); setSearchResults([]); }}
            className="flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
          <FolderOpen size={12} className="text-[var(--text-tertiary)]" />
          <span className="text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] truncate flex-1">
            {codeDirectory.split("/").pop() ?? "Files"}
          </span>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh file tree"
          >
            <RefreshCw size={11} className={refreshing ? "animate-spin" : undefined} />
          </button>
          <button
            onClick={() => { setSearchActive(true); setTimeout(() => searchInputRef.current?.focus(), 0); }}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title={`Search files (${mod}\u21e7F)`}
          >
            <Search size={11} />
          </button>
        </div>
      )}

      {/* Body — search results or file tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {searchActive ? (
          <>
            {searching && (
              <p className="text-[0.714rem] text-[var(--text-tertiary)] px-3 py-2">Searching…</p>
            )}
            {!searching && searchQuery.trim() && searchResults.length === 0 && (
              <p className="text-[0.714rem] text-[var(--text-tertiary)] px-3 py-4 text-center">No files found</p>
            )}
            {!searching && !searchQuery.trim() && (
              <p className="text-[0.714rem] text-[var(--text-tertiary)] px-3 py-4 text-center">Type to search files</p>
            )}
            {searchResults.map((result) => (
              <button
                key={result.path}
                onClick={() => { openEditorFile(result.path); setSearchActive(false); setSearchQuery(""); setSearchResults([]); }}
                className={cn(
                  "flex flex-col w-full px-3 py-1 text-left transition-colors rounded-sm",
                  activeEditorFile === result.path
                    ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
                )}
              >
                <span className="text-[0.786rem] truncate flex items-center gap-1.5">
                  <FileIcon name={result.name} size={11} />
                  {result.name}
                </span>
                <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate pl-4">
                  {result.relativePath.split("/").slice(0, -1).join("/") || "."}
                </span>
              </button>
            ))}
          </>
        ) : (
          <>
            {rootEntries.map((entry) => (
              <TreeNode
                key={`${refreshKey}:${entry.path}`}
                entry={entry}
                depth={0}
                activePath={activeEditorFile}
                onFileClick={openEditorFile}
              />
            ))}
            {rootEntries.length === 0 && (
              <p className="text-xs text-[var(--text-tertiary)] px-3 py-4 text-center">
                Directory is empty
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
