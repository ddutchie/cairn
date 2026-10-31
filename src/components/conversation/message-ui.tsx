"use client";

import React from "react";
import { Bot, User, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkLoader } from "@/components/ui/work-loader";
import type { WorkPhase } from "@/lib/conversation/work-phase";

export interface MessageAvatarProps {
  role: "user" | "assistant" | "bot" | "error";
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function MessageAvatar({ role, size = "md", className }: MessageAvatarProps) {
  const isUser = role === "user";
  const isError = role === "error";

  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  const iconSizes = {
    sm: 8,
    md: 10,
    lg: 11,
  };

  const iconSize = iconSizes[size];

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
        sizeClasses[size],
        isUser && "bg-[var(--surface-3)] border border-[var(--border)]",
        (role === "assistant" || role === "bot") && "bg-[var(--accent-dim)] border border-[var(--accent)]/20",
        isError && "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] border border-[var(--danger)]/30",
        className
      )}
    >
      {isUser && <User size={iconSize} className="text-[var(--text-tertiary)]" />}
      {(role === "assistant" || role === "bot") && <Bot size={iconSize} className="text-[var(--accent)]" />}
      {isError && <AlertCircle size={iconSize} className="text-[var(--danger)]" />}
    </div>
  );
}

export interface StreamingCursorProps {
  size?: "sm" | "md" | "lg";
  /** What the turn is doing right now; picks the animation. */
  phase?: WorkPhase;
  className?: string;
}

const CURSOR_PX = { sm: 16, md: 20, lg: 24 } as const;

/** Trailing activity indicator for a streaming turn. */
export function StreamingCursor({ size = "md", phase = "responding", className }: StreamingCursorProps) {
  return <WorkLoader phase={phase} size={CURSOR_PX[size]} className={cn("ml-1", className)} />;
}
