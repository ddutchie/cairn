"use client";

import React, { useState } from "react";
import { Sun, Moon, Monitor, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCairnStore, type Theme, type FontScale, type FontFamilyId } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "./shared";
import { ViewVisibilitySettings } from "./ViewVisibilitySettings";
import { AccentPicker } from "@/components/ui/accent-picker";
import { ChatThemePicker } from "@/components/ui/chat-theme-picker";
import { FONT_PRESETS } from "../../../shared/ui/fonts";

const FONT_SCALE_OPTIONS: { value: FontScale; label: string; description: string }[] = [
  { value: 1,   label: "XS", description: "100%" },
  { value: 1.1, label: "S",  description: "110%" },
  { value: 1.2, label: "M",  description: "120%" },
  { value: 1.3, label: "L",  description: "130%" },
  { value: 1.4, label: "XL", description: "140%" },
];

export function GeneralSettings() {
  const { workspaces, theme, setTheme, fontScale, setFontScale, fontFamily, setFontFamily, updateWorkspace, selectAndInitWorkspace } = useCairnStore(useShallow((s) => ({ workspaces: s.workspaces, theme: s.theme, setTheme: s.setTheme, fontScale: s.fontScale, setFontScale: s.setFontScale, fontFamily: s.fontFamily, setFontFamily: s.setFontFamily, updateWorkspace: s.updateWorkspace, selectAndInitWorkspace: s.selectAndInitWorkspace })));
  const workspace = workspaces[0];

  const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "light", label: "Light", icon: <Sun size={13} /> },
    { value: "system", label: "System", icon: <Monitor size={13} /> },
    { value: "dark", label: "Dark", icon: <Moon size={13} /> },
  ];

  return (
    <>
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
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = workspace?.name ?? "Personal";
              e.currentTarget.blur();
            }
          }}
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
      <SettingsRow label="Accent color" description="The highlight color used across the app">
        <AccentPicker className="w-48" />
      </SettingsRow>
      <SettingsRow label="Chat theme" description="The look of the chat surface — background, bubbles, and chat font">
        <ChatThemePicker className="w-52" />
      </SettingsRow>
      <SettingsRow label="Font size" description="Scale the UI text up or down">
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
          {FONT_SCALE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFontScale(opt.value)}
              title={opt.description}
              className={cn(
                "flex items-center justify-center w-8 py-1.5 rounded-md text-xs font-medium transition-colors",
                fontScale === opt.value
                  ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow label="Note font" description="Font used for note text (editor, preview, and PDF export)">
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
          {FONT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => setFontFamily(preset.id as FontFamilyId)}
              title={preset.description}
              className={cn(
                "flex items-center justify-center px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                fontFamily === preset.id
                  ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm border border-[var(--border)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </SettingsRow>
      <ChangeWorkspaceRow selectAndInitWorkspace={selectAndInitWorkspace} />
    </SettingsGroup>
    <ViewVisibilitySettings />
    </>
  );
}

function ChangeWorkspaceRow({ selectAndInitWorkspace }: { selectAndInitWorkspace: () => Promise<string | null> }) {
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
