/**
 * Sample workspace. Lets someone without a desktop-published iCloud source
 * (a first-time user, an App Review reviewer, a simulator where iCloud Drive
 * doesn't sync) explore the app against realistic data, and lets layouts
 * (iPhone Duo, iPad) be exercised in development.
 *
 * It is an ordinary local source DB under a reserved workspace id. Auto-sync is
 * skipped while it is active (see app/_layout.tsx and sync.ts), so nothing is
 * ever published to the shared sync folder. Reachable from onboarding in every
 * build; the id keeps its old "dev-" name so existing dev installs reuse it.
 */

import { getDb, setActiveSource } from "@/db";
import { createNote, createTask, setCardTags, setNoteTags } from "@/db/queries";
import { hasChatHistory, saveChatMessage } from "@/db/chat-store";

export const DEMO_WORKSPACE_ID = "dev-demo-workspace";

export function isDemoSource(workspaceId: string | null): boolean {
  return workspaceId === DEMO_WORKSPACE_ID;
}

const COLUMNS = [
  { type: "backlog", name: "Backlog" },
  { type: "todo", name: "To Do" },
  { type: "in_progress", name: "In Progress" },
  { type: "review", name: "Review" },
  { type: "done", name: "Done" },
] as const;

type ColumnType = (typeof COLUMNS)[number]["type"];

interface SeedProject {
  name: string;
  description: string;
  icon: string;
  priority: "low" | "medium" | "high" | "urgent";
  notes: { title: string; folder?: string; tags?: string[]; content: string }[];
  cards: { title: string; column: ColumnType; priority?: string; dueInDays?: number; tags?: string[]; description?: string }[];
}

const TAGS: { name: string; color: string }[] = [
  { name: "design", color: "#8b5cf6" },
  { name: "research", color: "#0ea5e9" },
  { name: "bug", color: "#ef4444" },
  { name: "idea", color: "#f59e0b" },
  { name: "mobile", color: "#10b981" },
];

// One line per paragraph: notes render single newlines as line breaks
// (remark-breaks on desktop, markdown-it `breaks` here), so hard-wrapping
// would show as ragged lines.
const LONG_NOTE = `# Getting started with Cairn

This is a **sample workspace** that lives only on this phone. Edit, add and delete anything here — none of it syncs. When you're ready, connect your own workspace from the desktop app and switch to it from the workspace menu at the top of Projects.

## What's here

- **Projects** hold notes and a task board. Open one to see both.
- **Calendar** shows tasks with due dates across every project.
- **Graph** maps how notes link to each other with [[wikilinks]].
- **Chat** can read and update your notes and tasks once an AI provider is set up in Settings → AI.

## Try it

- [x] Open this note
- [ ] Tap the pencil to edit it, then Save
- [ ] Move a task on the board by dragging it
- [ ] Ask Chat to summarise this note

## Phone and computer

Cairn keeps the phone and the desktop app in step through a shared iCloud folder.

| Where | What you do |
| --- | --- |
| Desktop | Settings → Sync, choose iCloud Drive › Cairn › sync |
| Phone | Pick the workspace when it appears |

> Your notes stay in your iCloud and on your devices. Cairn has no server of its own.
`;

const PROJECTS: SeedProject[] = [
  {
    name: "Welcome to Cairn",
    description: "A quick tour — this sample stays on this phone",
    icon: "👋",
    priority: "high",
    notes: [
      { title: "Getting started with Cairn", folder: "Start here", tags: ["idea"], content: LONG_NOTE },
      { title: "Linking notes", folder: "Start here", tags: ["research"], content: "# Linking notes\n\nType `[[` in a note to link another one, like [[Getting started with Cairn]]. Linked notes show up together in the Graph tab.\n" },
      { title: "Quick capture", tags: ["mobile"], content: "# Quick capture\n\nLong-press the Cairn icon, or add the Quick capture widget, to jot a thought, to-do or link in one tap." },
    ],
    cards: [
      { title: "Edit the getting-started note", column: "todo", priority: "high", tags: ["mobile"] },
      { title: "Drag this task to Done", column: "in_progress", priority: "medium", dueInDays: 1, description: "Press and hold a task, then drag it to another column." },
      { title: "Try asking Chat about your notes", column: "todo", priority: "medium", dueInDays: 3, tags: ["idea"] },
      { title: "Connect the desktop app", column: "backlog", priority: "low", description: "Desktop: Settings → Sync, choose iCloud Drive › Cairn › sync." },
      { title: "Open the sample workspace", column: "done", priority: "low" },
      { title: "Fix the leaky tap", column: "review", priority: "urgent", dueInDays: 2, tags: ["bug"] },
    ],
  },
  {
    name: "Garden Planner",
    description: "Seasonal planting schedule and notes",
    icon: "🌱",
    priority: "medium",
    notes: [
      { title: "Spring planting", folder: "Seasons", content: "# Spring planting\n\n- Tomatoes after last frost\n- Basil next to tomatoes\n- Peas early, they like cold" },
      { title: "Soil tests", tags: ["research"], content: "# Soil tests\n\npH 6.4 in the raised beds, 7.1 by the fence." },
      { title: "Composting ideas", tags: ["idea"], content: "# Composting ideas\n\nThree-bay system behind the shed." },
    ],
    cards: [
      { title: "Order seeds", column: "todo", priority: "high", dueInDays: 5 },
      { title: "Build raised bed #3", column: "in_progress", priority: "medium", dueInDays: 12 },
      { title: "Fix drip irrigation leak", column: "backlog", priority: "medium", tags: ["bug"] },
      { title: "Mulch the paths", column: "done" },
    ],
  },
  {
    name: "Reading List",
    description: "Books, papers and highlights",
    icon: "📚",
    priority: "low",
    notes: [
      { title: "Designing Data-Intensive Applications", folder: "Books", content: "# DDIA\n\nCh. 5 on replication maps neatly onto Cairn's HLC sync." },
      { title: "Local-first software", folder: "Papers", tags: ["research"], content: "# Local-first software\n\nSeven ideals: fast, multi-device, offline, collaboration, longevity, privacy, user control." },
    ],
    cards: [
      { title: "Finish DDIA chapter 9", column: "in_progress", dueInDays: 4 },
      { title: "Summarise CRDT paper", column: "todo", tags: ["research"] },
    ],
  },
  {
    name: "Trip to Lisbon",
    description: "Itinerary and bookings",
    icon: "✈️",
    priority: "medium",
    notes: [
      { title: "Itinerary", content: "# Itinerary\n\n**Day 1** Alfama, Miradouro da Senhora do Monte\n**Day 2** Belém, LX Factory\n**Day 3** Sintra" },
    ],
    cards: [
      { title: "Book flights", column: "done", priority: "high" },
      { title: "Reserve Sintra tickets", column: "todo", priority: "medium", dueInDays: 9 },
      { title: "Pack adapters", column: "backlog", priority: "low", dueInDays: 20 },
    ],
  },
];

function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  // Local calendar day — toISOString() is UTC and can land a day late.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Select the demo source, seeding it on first use. Idempotent: an already-
 * seeded demo DB is reused as-is so edits made while testing persist.
 */
export function openDemoWorkspace(): void {
  setActiveSource(DEMO_WORKSPACE_ID);
  const db = getDb();
  if (!db.getFirstSync("SELECT id FROM workspaces WHERE id = ?", DEMO_WORKSPACE_ID)) seedWorkspace();
  seedChat();
}

/**
 * A short conversation whose tool chips point at seeded notes / tasks, so the
 * chat preview column can be exercised without an AI provider. Only seeds an
 * empty history.
 */
export function seedChat(): void {
  if (hasChatHistory()) return;
  const db = getDb();
  const note = db.getFirstSync<{ id: string }>("SELECT id FROM notes WHERE title = ?", "Getting started with Cairn");
  const card = db.getFirstSync<{ id: string }>("SELECT id FROM task_cards WHERE title = ?", "Try asking Chat about your notes");
  saveChatMessage({ role: "user", content: "What should I try first, and can you note that I asked?" });
  saveChatMessage({
    role: "assistant",
    content:
      "Start with the **Getting started** note: edit it, then drag a task across the board. I added a note to the **Try asking Chat about your notes** task. This is a sample reply — set up an AI provider in Settings → AI to chat for real.",
    tools: [
      ...(note ? [{ tool: "get_item", ok: true, ref: { kind: "note" as const, id: note.id } }] : []),
      ...(card ? [{ tool: "update_tasks", ok: true, ref: { kind: "card" as const, id: card.id } }] : []),
    ],
  });
}

function seedWorkspace(): void {
  const db = getDb();

  const now = new Date().toISOString();
  db.withTransactionSync(() => {
    db.runSync(
      "INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      DEMO_WORKSPACE_ID,
      "Sample workspace",
      "Sample data on this phone only — never synced",
      now,
      now,
    );

    const tagIds = new Map<string, string>();
    for (const tag of TAGS) {
      const id = `demo-tag-${tag.name}`;
      db.runSync(
        "INSERT INTO tags (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        DEMO_WORKSPACE_ID,
        tag.name,
        tag.color,
        now,
        now,
      );
      tagIds.set(tag.name, id);
    }
    const resolveTags = (names?: string[]) => (names ?? []).map((n) => tagIds.get(n)!).filter(Boolean);

    PROJECTS.forEach((project, pi) => {
      const projectId = `demo-project-${pi}`;
      db.runSync(
        `INSERT INTO projects (id, workspace_id, name, description, icon, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        DEMO_WORKSPACE_ID,
        project.name,
        project.description,
        project.icon,
        project.priority,
        now,
        now,
      );

      const columnIds = new Map<ColumnType, string>();
      COLUMNS.forEach((col, ci) => {
        const columnId = `${projectId}-col-${col.type}`;
        db.runSync(
          `INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          columnId,
          projectId,
          DEMO_WORKSPACE_ID,
          col.name,
          col.type,
          ci,
          now,
          now,
        );
        columnIds.set(col.type, columnId);
      });

      for (const note of project.notes) {
        const noteId = createNote(projectId, note.title, note.content, note.folder);
        if (note.tags) setNoteTags(noteId, resolveTags(note.tags));
      }

      for (const card of project.cards) {
        const cardId = createTask(projectId, columnIds.get(card.column)!, card.title, {
          description: card.description,
          priority: card.priority,
        });
        if (card.tags) setCardTags(cardId, resolveTags(card.tags));
        if (card.dueInDays != null) {
          db.runSync("UPDATE task_cards SET due_date = ? WHERE id = ?", isoInDays(card.dueInDays), cardId);
        }
      }
    });
  });
}
