"use client";

import React from "react";
import { Bot, User, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

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
  className?: string;
}

export function StreamingCursor({ size = "md", className }: StreamingCursorProps) {
  const sizeClasses = {
    sm: "h-2.5",
    md: "h-3",
    lg: "h-3.5",
  };

  return (
    <span
      className={cn(
        "inline-block w-0.5 bg-[var(--accent)] animate-pulse ml-0.5 align-middle",
        sizeClasses[size],
        className
      )}
    />
  );
}
