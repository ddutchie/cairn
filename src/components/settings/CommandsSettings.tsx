"use client";

import React, { useState, useEffect, useMemo } from "react";
import { Plus, X, Pencil, Check, SlashSquare, Users, Download } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup } from "./shared";
import { cn } from "@/lib/utils";
import { ALL_BUILTIN_COMMANDS, isReservedCommandName } from "@/lib/slash-commands";
import { BrowseCommandsModal } from "./tools/BrowseCommandsModal";
import type { CustomSlashCommand, SlashCommandScope } from "@/types";

const SCOPE_LABEL: Record<SlashCommandScope, string> = {
  chat: "Chat",
  agent: "Agent",
  both: "Chat + Agent",
};

const SCOPE_OPTIONS: SlashCommandScope[] = ["both", "chat", "agent"];

/** Slash command names are inserted as `/name`; keep them clean + unambiguous. */
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function CommandsSettings() {
  const {
    customCommands,
    activeWorkspaceId,
    fetchCommands,
    createCommand,
    updateCommand,
    deleteCommand,
  } = useCairnStore(
    useShallow((s) => ({
      customCommands: s.customCommands,
      activeWorkspaceId: s.activeWorkspaceId,
      fetchCommands: s.fetchCommands,
      createCommand: s.createCommand,
      updateCommand: s.updateCommand,
      deleteCommand: s.deleteCommand,
    }))
  );

  useEffect(() => {
    if (activeWorkspaceId) void fetchCommands(activeWorkspaceId);
  }, [activeWorkspaceId, fetchCommands]);

  const workspaceCommands = useMemo(
    () => customCommands.filter((c) => c.workspaceId === activeWorkspaceId),
    [customCommands, activeWorkspaceId]
  );

  const existingNames = useMemo(
    () => new Set(workspaceCommands.map((c) => c.name)),
    [workspaceCommands]
  );

  const [browseOpen, setBrowseOpen] = useState(false);

  return (
    <div className="space-y-6 md:space-y-8">
      <CreateCommandForm
        disabled={!activeWorkspaceId}
        existingNames={existingNames}
        onCreate={(input) => {
          if (!activeWorkspaceId) return;
          void createCommand({ workspaceId: activeWorkspaceId, ...input });
        }}
      />

      <SettingsGroup
        title="Your commands"
        description="Custom slash commands available in this workspace's chat and agent inputs."
      >
        {workspaceCommands.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <SlashSquare size={20} className="text-[var(--text-tertiary)] opacity-40" />
            <p className="text-sm text-[var(--text-tertiary)]">No custom commands yet.</p>
            <p className="text-xs text-[var(--text-tertiary)]">
              Add one above — type <span className="font-mono">/</span> in a chat to use it.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {workspaceCommands.map((cmd) => (
              <CommandRow
                key={cmd.id}
                command={cmd}
                onUpdate={(patch) => void updateCommand(cmd.id, patch)}
                onDelete={() => void deleteCommand(cmd.id)}
              />
            ))}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Built-in commands"
        description="Ship with Cairn. Add a custom command with the same name to override its inserted text."
      >
        <div className="space-y-1.5">
          {ALL_BUILTIN_COMMANDS.map((cmd) => (
            <div
              key={cmd.name}
              className="flex items-start gap-3 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]"
            >
              <span className="text-xs font-mono font-semibold text-[var(--accent)] whitespace-nowrap pt-0.5">
                /{cmd.name}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[var(--text-secondary)]">{cmd.description}</div>
              </div>
              <span className="text-[0.643rem] uppercase tracking-wider text-[var(--text-tertiary)] whitespace-nowrap pt-0.5">
                {SCOPE_LABEL[cmd.scope]}
              </span>
            </div>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Community commands"
        description="Browse and install commands shared by the Cairn community."
      >
        <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
          <Users size={16} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <div className="flex-1 text-xs text-[var(--text-tertiary)]">
            Install ready-made commands from the{" "}
            <span className="font-mono">cairn-community</span> registry, then tweak them under
            Your commands.
          </div>
          <button
            type="button"
            disabled={!activeWorkspaceId}
            onClick={() => setBrowseOpen(true)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex-shrink-0",
              activeWorkspaceId
                ? "bg-[var(--accent)] text-white hover:bg-[color-mix(in_srgb,var(--accent)_90%,black)]"
                : "bg-[var(--surface)] text-[var(--text-tertiary)] cursor-not-allowed"
            )}
          >
            <Download size={13} /> Browse Community
          </button>
        </div>
      </SettingsGroup>

      {browseOpen && <BrowseCommandsModal onClose={() => setBrowseOpen(false)} />}
    </div>
  );
}

// ── Create form ───────────────────────────────

function CreateCommandForm({
  disabled,
  existingNames,
  onCreate,
}: {
  disabled: boolean;
  existingNames: Set<string>;
  onCreate: (input: {
    name: string;
    description: string;
    insertText: string;
    scope: SlashCommandScope;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [insertText, setInsertText] = useState("");
  const [scope, setScope] = useState<SlashCommandScope>("both");

  const cleanName = sanitizeName(name);
  const duplicate = cleanName.length > 0 && existingNames.has(cleanName);
  const reserved = cleanName.length > 0 && isReservedCommandName(cleanName);
  const canSubmit = cleanName.length > 0 && insertText.trim().length > 0 && !duplicate && !reserved;

  function reset() {
    setName("");
    setDescription("");
    setInsertText("");
    setScope("both");
  }

  function submit() {
    if (!canSubmit) return;
    onCreate({ name: cleanName, description: description.trim(), insertText, scope });
    reset();
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors border",
          disabled
            ? "opacity-50 cursor-not-allowed border-[var(--border)] text-[var(--text-tertiary)]"
            : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
        )}
      >
        <Plus size={13} /> New command
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--text-primary)]">New command</span>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          title="Close"
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >
          <X size={13} />
        </button>
      </div>

      <label className="block">
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">Name</span>
        <div className="flex items-center gap-1.5 mt-1 rounded-md bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 focus-within:border-[var(--accent)]">
          <span className="text-xs font-mono text-[var(--text-tertiary)]">/</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-command"
            className="flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none font-mono"
          />
        </div>
        {duplicate && (
          <span className="text-[0.643rem] text-[var(--danger)] mt-1 inline-block">
            A command named /{cleanName} already exists.
          </span>
        )}
        {reserved && !duplicate && (
          <span className="text-[0.643rem] text-[var(--danger)] mt-1 inline-block">
            /{cleanName} is a reserved built-in command and can&apos;t be overridden.
          </span>
        )}
      </label>

      <label className="block">
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this command does"
          className="w-full mt-1 rounded-md bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </label>

      <label className="block">
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">Inserted text</span>
        <textarea
          value={insertText}
          onChange={(e) => setInsertText(e.target.value)}
          placeholder="The prompt or text inserted when the command is chosen"
          rows={3}
          className="w-full mt-1 rounded-md bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
        />
      </label>

      <label className="block">
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">Show in</span>
        <div className="flex gap-1.5 mt-1">
          {SCOPE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn(
                "px-2.5 py-1 rounded-md text-[0.714rem] border transition-colors",
                scope === s
                  ? "bg-[var(--accent-dim)] text-[var(--accent)] border-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface)]"
              )}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="px-3 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--surface)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className={cn(
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            canSubmit
              ? "bg-[var(--accent)] text-white hover:bg-[color-mix(in_srgb,var(--accent)_90%,black)]"
              : "bg-[var(--surface)] text-[var(--text-tertiary)] cursor-not-allowed"
          )}
        >
          Add command
        </button>
      </div>
    </div>
  );
}

// ── Command row (view / inline edit) ──────────

function CommandRow({
  command,
  onUpdate,
  onDelete,
}: {
  command: CustomSlashCommand;
  onUpdate: (patch: Partial<Pick<CustomSlashCommand, "name" | "description" | "insertText" | "scope">>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(command.description);
  const [insertText, setInsertText] = useState(command.insertText);
  const [scope, setScope] = useState<SlashCommandScope>(command.scope);

  function save() {
    onUpdate({ description: description.trim(), insertText, scope });
    setEditing(false);
  }

  function cancel() {
    setDescription(command.description);
    setInsertText(command.insertText);
    setScope(command.scope);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-[var(--accent)] bg-[var(--surface-2)] p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-semibold text-[var(--accent)]">/{command.name}</span>
          {command.source === "community" && (
            <span className="text-[0.643rem] text-[var(--text-tertiary)]">(community)</span>
          )}
        </div>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="w-full rounded-md bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <textarea
          value={insertText}
          onChange={(e) => setInsertText(e.target.value)}
          rows={3}
          className="w-full rounded-md bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
        />
        <div className="flex gap-1.5">
          {SCOPE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn(
                "px-2.5 py-1 rounded-md text-[0.714rem] border transition-colors",
                scope === s
                  ? "bg-[var(--accent-dim)] text-[var(--accent)] border-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface)]"
              )}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="px-2.5 py-1 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--surface)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={insertText.trim().length === 0}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium",
              insertText.trim().length === 0
                ? "bg-[var(--surface)] text-[var(--text-tertiary)] cursor-not-allowed"
                : "bg-[var(--accent)] text-white hover:bg-[color-mix(in_srgb,var(--accent)_90%,black)]"
            )}
          >
            <Check size={12} /> Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
      <span className="text-xs font-mono font-semibold text-[var(--accent)] whitespace-nowrap pt-0.5">
        /{command.name}
      </span>
      <div className="flex-1 min-w-0">
        {command.description && (
          <div className="text-xs text-[var(--text-secondary)]">{command.description}</div>
        )}
        <div className="text-[0.714rem] text-[var(--text-tertiary)] font-mono truncate mt-0.5">
          {command.insertText}
        </div>
      </div>
      <span className="text-[0.643rem] uppercase tracking-wider text-[var(--text-tertiary)] whitespace-nowrap pt-0.5">
        {SCOPE_LABEL[command.scope]}
      </span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          title="Edit"
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)]"
          title="Delete"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
