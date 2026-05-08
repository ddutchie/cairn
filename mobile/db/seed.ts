/**
 * Cairn Mobile — workspace seeder
 *
 * Creates a brand-new workspace.db in expo-sqlite's default app directory
 * with a default workspace, sample project, board columns, cards and notes.
 */

import { openDb, getDb } from "./client";

const id = () =>
  Math.random().toString(36).slice(2, 9) +
  Math.random().toString(36).slice(2, 9);
const now = () => new Date().toISOString();

// Filename used for the local demo DB — also persisted in AsyncStorage
export const DEMO_DB_FILENAME = "workspace.db";

export async function createFreshWorkspace(): Promise<{ workspaceId: string }> {
  // Open (or recreate) the DB at the default expo-sqlite location
  await openDb(DEMO_DB_FILENAME);
  const db = getDb();

  const workspaceId = id();
  const projectId = id();
  const timestamp = now();

  // Clear any previous demo data (idempotent re-runs)
  await db.execAsync(`
    DELETE FROM task_cards;
    DELETE FROM board_columns;
    DELETE FROM notes;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);

  // ── Workspace ─────────────────────────────────────────────────────────
  await db.runAsync(
    `INSERT INTO workspaces (id, name, description, icon, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [workspaceId, "My Workspace", "Created on Cairn Mobile", "🗿", timestamp, timestamp]
  );

  // ── Project ───────────────────────────────────────────────────────────
  await db.runAsync(
    `INSERT INTO projects
       (id, workspace_id, name, description, icon, status, priority, tag_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId, workspaceId,
      "Cairn Mobile", "iOS companion app experiment",
      "📱", "active", "high", "[]", timestamp, timestamp,
    ]
  );

  // ── Board columns ──────────────────────────────────────────────────────
  const columns = [
    { name: "Backlog",     type: "backlog",     order: 0 },
    { name: "Todo",        type: "todo",        order: 1 },
    { name: "In Progress", type: "in_progress", order: 2 },
    { name: "Review",      type: "review",      order: 3 },
    { name: "Done",        type: "done",        order: 4 },
  ];

  const columnIds: Record<string, string> = {};
  for (const col of columns) {
    const colId = id();
    columnIds[col.type] = colId;
    await db.runAsync(
      `INSERT INTO board_columns
         (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [colId, projectId, workspaceId, col.name, col.type, col.order, timestamp, timestamp]
    );
  }

  // ── Task cards ─────────────────────────────────────────────────────────
  const cards = [
    { title: "Set up Expo project",        col: "done",        priority: "high",   order: 0 },
    { title: "Wire up expo-sqlite schema", col: "done",        priority: "high",   order: 1 },
    { title: "Build onboarding screen",    col: "in_progress", priority: "high",   order: 0 },
    { title: "Projects & Board views",     col: "in_progress", priority: "high",   order: 1 },
    { title: "Notes list + reader",        col: "todo",        priority: "medium", order: 0 },
    { title: "AI Chat integration",        col: "todo",        priority: "medium", order: 1 },
    { title: "iCloud sync testing",        col: "backlog",     priority: "low",    order: 0 },
    { title: "iPad split-view layout",     col: "backlog",     priority: "low",    order: 1 },
    { title: "Dark / light theme polish",  col: "backlog",     priority: "low",    order: 2 },
  ];

  for (const card of cards) {
    await db.runAsync(
      `INSERT INTO task_cards
         (id, column_id, project_id, workspace_id, title, priority, tag_ids,
          linked_note_ids, blocked_by_ids, "order", version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, 0, ?, ?)`,
      [id(), columnIds[card.col], projectId, workspaceId,
       card.title, card.priority, card.order, timestamp, timestamp]
    );
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  const notes = [
    {
      title: "Welcome to Cairn Mobile",
      isPinned: 1,
      content: `# Welcome to Cairn Mobile 👋

This is a demo workspace so you can explore the app without needing your desktop workspace synced via iCloud.

## What you can do

- Browse the **Board** to see task cards across columns
- Read and edit **Notes** in markdown
- Start an **AI Chat** conversation (configure your API key in Settings first)

## Sync with desktop

When you're ready to connect your real Cairn workspace:

1. Move your Cairn workspace folder to **iCloud Drive**
2. Go to **Settings → Disconnect workspace**
3. Re-open and select your \`workspace.db\` file`,
      contentText: "Welcome to Cairn Mobile. Demo workspace to explore the app.",
    },
    {
      title: "Mobile Architecture Notes",
      isPinned: 0,
      content: `# Mobile Architecture Notes

## Stack

- **Expo SDK 55** + Expo Router (file-based navigation)
- **expo-sqlite** — same schema as the desktop Electron app
- **Zustand** — state management (shared slice pattern)
- **NativeWind v4** — Tailwind CSS for React Native
- **Vercel AI SDK** — direct streaming to OpenAI / Anthropic / Groq

## Data sync strategy

The mobile app opens the desktop's \`workspace.db\` SQLite file directly via iCloud Drive. No custom sync protocol needed — iCloud handles file sync between devices.`,
      contentText: "Mobile architecture notes covering stack and sync strategy.",
    },
    {
      title: "AI Chat Setup Guide",
      isPinned: 0,
      content: `# AI Chat Setup

## Supported providers

| Provider | Models |
|----------|--------|
| OpenAI | gpt-4o, gpt-4o-mini |
| Anthropic | claude-opus-4-5, claude-sonnet-4-5 |
| Groq | llama-3.3-70b-versatile |

## How to configure

1. Go to the **Settings** tab
2. Select your provider and model
3. Paste your API key
4. Tap **Save AI Config**

Your key is stored locally on-device and never sent anywhere except the provider's API.`,
      contentText: "Guide to setting up AI Chat with OpenAI, Anthropic, or Groq.",
    },
  ];

  for (const note of notes) {
    await db.runAsync(
      `INSERT INTO notes
         (id, project_id, workspace_id, title, content, content_text,
          tag_ids, linked_note_ids, linked_card_ids, is_pinned, type,
          folder, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, 'note', '', 0, ?, ?)`,
      [id(), projectId, workspaceId, note.title, note.content,
       note.contentText, note.isPinned, timestamp, timestamp]
    );
  }

  return { workspaceId };
}
