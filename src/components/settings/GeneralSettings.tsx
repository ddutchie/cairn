"use client";

import React, { useState } from "react";
import { Sun, Moon, Monitor, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCairnStore, type Theme } from "@/store";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "./shared";

export function GeneralSettings() {
  const { workspaces, theme, setTheme, updateWorkspace, selectAndInitWorkspace } = useCairnStore();
  const workspace = workspaces[0];

  const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "light", label: "Light", icon: <Sun size={13} /> },
    { value: "system", label: "System", icon: <Monitor size={13} /> },
    { value: "dark", label: "Dark", icon: <Moon size={13} /> },
  ];

  return (
    <SettingsGroup title="General" description="Basic app preferences">
      <SettingsRow label="Workspace name" description="Name shown in the sidebar">
        <Input
          defaultValue={workspace?.name ?? "Personal"}
          className="w-48 text-xs"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (workspace && name && name !== workspace.name) {
              updateWorkspace(workspace.id, { name });
            }
          }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      </SettingsRow>
      <SettingsRow label="Theme" description="Choose light, dark, or follow your system setting">
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                theme === opt.value
                  ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </SettingsRow>
      <ChangeWorkspaceRow />
    </SettingsGroup>
  );
}

function ChangeWorkspaceRow() {
  const { selectAndInitWorkspace } = useCairnStore();
  const [changing, setChanging] = useState(false);
  const [done, setDone] = useState(false);

  async function handleChange() {
    setChanging(true);
    try {
      const folder = await selectAndInitWorkspace();
      if (!folder) return;
      setDone(true);
      setTimeout(() => window.location.reload(), 1000);
    } finally {
      setChanging(false);
    }
  }

  return (
    <SettingsRow label="Workspace folder" description="Move your workspace to a different folder">
      <Button variant="default" size="sm" onClick={handleChange} disabled={changing}>
        {done ? (
          <><CheckCircle size={12} className="text-[var(--success)]" /> Changed</>
        ) : changing ? (
          <><Loader2 size={12} className="animate-spin" /> Selecting…</>
        ) : (
          <>Change folder</>
        )}
      </Button>
    </SettingsRow>
  );
}
