import * as React from "react";
import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?: string;
}

export function Badge({ className, color, children, style, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        "border",
        className
      )}
      style={{
        backgroundColor: color ? `color-mix(in srgb, ${color} 10%, transparent)` : "var(--surface-3)",
        borderColor: color ? `color-mix(in srgb, ${color} 25%, transparent)` : "var(--border)",
        color: color ?? "var(--text-secondary)",
        ...style,
      }}
      {...props}
    >
      {color && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: color }}
        />
      )}
      {children}
    </span>
  );
}
