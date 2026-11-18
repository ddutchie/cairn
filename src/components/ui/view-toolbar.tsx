import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The control strip under a view's tab bar, or at the top of a toolbar view
 * (Usage, Automations, Knowledge Graph, Insights). One height, one rule, one
 * surface, so these views read as the same product. See docs/design-language.md.
 *
 * `title` and `description` are optional (a view with tabs above it omits
 * them). `actions` sit at the right edge and wrap with the rest.
 */
export function ViewToolbar({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "@container flex items-center gap-x-2 gap-y-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex-wrap",
        className,
      )}
    >
      {title && <h1 className="text-sm font-semibold text-[var(--text-primary)] mr-1">{title}</h1>}
      {description && <div className="hidden @lg:block text-xs text-[var(--text-tertiary)] mr-2">{description}</div>}
      {children}
      {actions && <div className="ml-auto flex items-center justify-end gap-2 flex-wrap min-w-0">{actions}</div>}
    </div>
  );
}
