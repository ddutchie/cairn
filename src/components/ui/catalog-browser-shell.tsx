"use client";

import type { ReactNode } from "react";
import { Search, RefreshCw, WifiOff } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

/** Shared search-input styling for catalog browsers. */
export const CATALOG_SEARCH_INPUT_CLS =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm pl-8 pr-3 py-2 focus:outline-none";

/**
 * True for safe external link targets. Registry entries are untrusted input —
 * a malicious catalog could carry a `javascript:` homepage/apiKeyUrl, which
 * would execute in the renderer context on click. Only http(s) links render.
 */
export function isSafeExternalUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

/** Category pill used by every registry browser (plus browse-automations). */
export function TagChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-[0.65rem] rounded-full px-2 py-0.5 border transition-colors",
        active
          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--text-primary)]"
          : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
      )}
    >
      {label}
    </button>
  );
}

interface CatalogBrowserShellProps {
  onClose: () => void;
  title: ReactNode;
  description?: string;
  /** Search box state. */
  query: string;
  onQueryChange: (q: string) => void;
  searchPlaceholder: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** Category pills. Omitted (or empty) when the catalog has no categories. */
  categories?: string[];
  activeCategory?: string | null;
  onCategoryChange?: (c: string | null) => void;
  /** Registry fetch failure (provenance banner). */
  registryError?: string | null;
  fromCache?: boolean;
  installError?: string | null;
  /** Slot between the banners and the list (e.g. the OAuth post-install prompt). */
  notice?: ReactNode;
  loading: boolean;
  /** True when the catalog has entries (decides "empty catalog" vs "no matches"). */
  hasEntries: boolean;
  emptyText: string;
  /** True when the current filter yields rows. False renders "No matches." */
  hasResults: boolean;
  /** Result rows. */
  children: ReactNode;
  /** Caption rendered under the list. */
  belowList?: ReactNode;
}

/**
 * Shared chrome for the four registry browsers (community tools, commands,
 * providers, personalities): ModalShell + search/refresh/category toolbar +
 * provenance + install-error banners + loading/empty list states. Row
 * rendering stays per-modal (passed as children).
 */
export function CatalogBrowserShell({
  onClose,
  title,
  description,
  query,
  onQueryChange,
  searchPlaceholder,
  refreshing,
  onRefresh,
  categories = [],
  activeCategory = null,
  onCategoryChange,
  registryError,
  fromCache = false,
  installError,
  notice,
  loading,
  hasEntries,
  emptyText,
  hasResults,
  children,
  belowList,
}: CatalogBrowserShellProps) {
  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={title}
      description={description}
    >
      {/* Toolbar: search + categories + refresh */}
      <div className="flex flex-col gap-3 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <input
              className={CATALOG_SEARCH_INPUT_CLS}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh from the registry"
          >
            {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
            Refresh
          </Button>
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <TagChip label="All" active={activeCategory === null} onClick={() => onCategoryChange?.(null)} />
            {categories.map((cat) => (
              <TagChip
                key={cat}
                label={cat}
                active={activeCategory === cat}
                onClick={() => onCategoryChange?.(cat)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Provenance / error banner */}
      {registryError && (
        <div className="mt-3 flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)]">
          <WifiOff size={12} />
          {fromCache
            ? "Showing the cached catalog — couldn't reach the registry."
            : `Couldn't load the registry: ${registryError}`}
        </div>
      )}
      {installError && (
        <div className="mt-3 text-[0.714rem] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] rounded px-3 py-2">
          {installError}
        </div>
      )}

      {notice}

      {/* List */}
      <div className="mt-3 flex flex-col gap-2 min-h-[8rem]">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-[var(--text-tertiary)]">
            <Spinner size={18} />
          </div>
        ) : !hasEntries ? (
          <EmptyState title={emptyText} className="py-10" />
        ) : !hasResults ? (
          <EmptyState title="No matches." className="py-10" />
        ) : (
          children
        )}
      </div>

      {belowList}
    </ModalShell>
  );
}
