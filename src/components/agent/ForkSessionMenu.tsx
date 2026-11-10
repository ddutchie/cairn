"use client";

import { Code2, GitFork, MessageSquarePlus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { IconButton } from "@/components/ui/icon-button";
import { useForkSession, type ForkSource } from "./useForkSession";

/**
 * Fork, in the action row of the last reply of a finished turn: continue this conversation in a new chat or
 * coding session. Renders nothing for a session that cannot be forked.
 */
export function ForkSessionMenu({ source }: { source: ForkSource }) {
  const { options, fork, forking } = useForkSession(source);
  if (!options.source) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Fork this session" tooltip="Fork" tooltipSide="top" disabled={forking} className="size-auto p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]">
          <GitFork size={10} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {options.source === "chat" && (
          <DropdownMenuItem onSelect={() => void fork("chat")} className="items-start py-2">
            <MessageSquarePlus size={13} className="mt-0.5 flex-shrink-0 text-[var(--accent)]" />
            <span>
              <span className="block font-medium text-[var(--text-primary)]">Fork into a chat</span>
              <span className="block text-2xs text-[var(--text-tertiary)]">A new thread that starts with this conversation</span>
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!options.toCoding} onSelect={() => void fork("coding")} className="items-start py-2">
          <Code2 size={13} className="mt-0.5 flex-shrink-0 text-[var(--accent)]" />
          <span>
            <span className="block font-medium text-[var(--text-primary)]">Fork into a coding session</span>
            <span className="block text-2xs text-[var(--text-tertiary)]">
              {options.codingBlocked ?? (options.source === "chat" ? "Carry this conversation into the code folder" : "A new session that starts with this conversation")}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
