import * as React from "react";
import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?: string;
  size?: "sm" | "xs";
}

export function Badge({ className, color, size = "sm", children, style, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border",
        size === "sm" && "px-1.5 py-0.5 text-[0.786rem] font-medium",
        size === "xs" && "px-1 py-0.5 text-[0.643rem] font-medium",
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
          className={cn(
            "inline-block rounded-full flex-shrink-0",
            size === "sm" ? "w-1.5 h-1.5" : "w-1 h-1"
          )}
          style={{ backgroundColor: color }}
        />
      )}
      {children}
    </span>
  );
}
