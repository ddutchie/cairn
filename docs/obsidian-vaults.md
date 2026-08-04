# Using Cairn with an existing Obsidian vault

Cairn stores notes as plain Markdown files on disk, so you can point a Cairn
workspace directly at an Obsidian vault (or copy a folder of notes into a Cairn
workspace) and keep editing in both tools. This page explains what Cairn does to
your files, what stays compatible with Obsidian, and the one thing to be aware
of before you start.

> **Back up first.** Before pointing Cairn at a vault you care about, take a
> backup or commit it to git. Cairn adds a small block of its own frontmatter to
> each note the first time it imports it (details below). This is non-destructive,
> but a backup means you can always diff or roll back.

## How import works

When you open a workspace folder — during onboarding, on every app launch, or
when you copy a folder in while Cairn is running — Cairn scans the folder and:

1. **Creates a project for every top-level folder** that contains at least one
   non-skipped `.md` file (searched recursively). The project's name is the
   folder's name.
2. **Creates one catch-all project** — named after the vault folder — for any
   loose `.md` files that sit directly in the vault root.
3. **Imports each `.md` file** as a note under the matching project, preserving
   its subfolder path.

Re-scanning is idempotent: folders that already map to a project are left alone,
so you won't get duplicate projects or notes.

### What Cairn skips

- Dot-folders: `.obsidian`, `.git`, `.trash`, etc.
- Infrastructure folders: `assets`, `attachments`.
- Template folders named `templates` at any depth.
- Excalidraw scene files ending in `*.excalidraw.md`.
- Top-level folders you untick in the onboarding import preview. Cairn remembers
  these choices in `.cairn-import.json` and continues skipping them on later scans.

A top-level folder becomes a project only if it holds at least one non-skipped
`.md` file (searched recursively). If your vault has many organisational folders
(`inbox`, `archive`, `daily`, …) you'll get a project for each — you can merge,
rename, or archive projects afterwards in Cairn.

## What Cairn writes to your notes

Cairn manages a fixed set of frontmatter keys and **preserves all your other
keys and their values** on every save. The frontmatter is re-serialised as YAML,
so its formatting may be normalised — comments, quoting style, and key ordering
can change even though the data is kept (see *First-touch git diffs* below):

```yaml
---
# Your Obsidian fields — always preserved:
tags:
  - architecture
aliases:
  - "Arch Overview"
cssclasses:
  - custom-note
publish: true
myCustomField: anything

# Cairn-managed fields — added on import:
id: 3f9c1a2b
projectId: 8a7d…
workspaceId: 1c2e…
title: Architecture Overview
folder: ""
tagIds: []
linkedNoteIds: []
linkedCardIds: []
isPinned: false
createdAt: 2025-01-01T00:00:00.000Z
updatedAt: 2025-01-02T00:00:00.000Z
---
```

Cairn-owned keys: `id`, `projectId`, `workspaceId`, `title`, `folder`,
`tagIds`, `linkedNoteIds`, `linkedCardIds`, `isPinned`, `createdAt`,
`updatedAt`, `archivedAt`. None of these collide with Obsidian's reserved
properties (`tags`, `aliases`, `cssclasses`).

### Fully compatible

- **Obsidian properties** (`tags`, `aliases`, `cssclasses`, `date`, `publish`,
  custom keys, and nested values) are preserved — their values survive every
  save (the YAML formatting may be re-normalised, see below).
- **Obsidian tags** in a note's `tags:` property are imported as Cairn tags.
- **Body content** — `[[wikilinks]]`, `![[embeds]]`, task checkboxes, inline
  `#tags` — is never modified by import.

## Filenames and wikilinks

Obsidian resolves `[[wikilinks]]` by **filename**. Cairn respects this:

- **Import never renames a file.** Cairn injects its frontmatter in place; the
  filename you had in Obsidian is kept exactly.
- **Editing a note's content, tags, pin state, or links never renames the file.**
  Even if a note's `title` property differs from its filename (common in
  Obsidian), the file stays put — so your wikilinks keep resolving.
- **Renaming a note in Cairn does rename the file** — and Cairn rewrites inbound
  `[[wikilinks]]` in your other notes to match. Rewriting covers the standard
  wikilink forms (`[[Note]]`, `[[Note|alias]]`, `[[Note#heading]]`, and
  `![[Note]]` embeds); Markdown-style links (`[text](Note.md)`) are not rewritten.
- **Moving a note to another folder/project** relocates the file, keeping its
  filename.

## Import preview and backup

When Cairn detects an Obsidian vault during onboarding, it scans the folder
read-only first and shows the projects and note counts it found. Untick any
top-level folder you do not want Cairn to adopt. No note frontmatter is written
until you confirm by creating the workspace.

Make a backup or git commit before confirming. This gives you a straightforward
rollback for Cairn's first-touch frontmatter changes: close Cairn, restore the
vault files from your backup, and remove `.cairn-import.json` if you also want to
reset the saved exclusions.

## Known limitations

- **Plugin-specific Markdown may still need exclusion.** Cairn skips templates
  and Excalidraw files by default, but Kanban/Dataview helper files use no single
  reliable filename convention. Untick their top-level folder in the preview or
  keep them in a dot-folder Cairn ignores.
- **First-touch git diffs.** The first time Cairn writes a note it re-serialises
  the YAML frontmatter (normalising quoting and key order) and adds its own keys,
  which produces a one-time diff even on notes you didn't edit. Subsequent saves
  only change what actually changed.

## Attachments

Pasting an image into a note saves it to your vault's attachment folder (read
from `.obsidian/app.json` when present, otherwise `attachments/`) and inserts
`![[filename]]` — so images render in both Cairn and Obsidian.
