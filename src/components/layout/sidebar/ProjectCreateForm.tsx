"use client";

import React, { useRef, useEffect } from "react";
import { Check, X } from "lucide-react";
import { ProjectIcon } from "@/lib/workspace-icons";
import { Tooltip } from "@/components/ui/tooltip";

interface ProjectCreateFormProps {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function ProjectCreateForm({ value, onChange, onCommit, onCancel }: ProjectCreateFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--surface-2)]">
      <ProjectIcon name={undefined} size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Project name"
        className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
      />
      <Tooltip content="Confirm">
        <button onClick={onCommit} className="p-0.5 text-[var(--success)] hover:opacity-80">
          <Check size={11} />
        </button>
      </Tooltip>
      <Tooltip content="Cancel">
        <button onClick={onCancel} className="p-0.5 text-[var(--text-tertiary)] hover:opacity-80">
          <X size={11} />
        </button>
      </Tooltip>
    </div>
  );
}
