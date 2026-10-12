/**
 * DEV-ONLY demo workspace. Lets the app run without a desktop-published iCloud
 * source — e.g. on a simulator, where iCloud Drive doesn't sync — so layouts
 * (iPhone Duo, iPad) can be exercised against realistic data.
 *
 * The demo is an ordinary local source DB under a reserved workspace id. Auto-
 * sync is skipped while it is active (see app/_layout.tsx), so nothing is ever
 * published to the shared sync folder. Only reachable from `__DEV__` builds.
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
const LONG_NOTE = `# Foldable layout research

The iPhone Duo folds from a phone-sized screen into a near-square canvas. Apps get a live size-class change when it opens, so layouts must adapt **without a relaunch** and keep whatever the user was looking at.

## Principles

- One tree, two layouts: stacked when compact, columns when regular.
- Selection lives in state, not in the navigation stack.
- Never lock orientation on a device whose shape changes.

## Checklist

- [x] Upgrade to Expo SDK 58
- [ ] Split view for Projects
- [ ] Sidebar-adaptable tab bar
- [ ] Readable line length in the editor

## Notes

Wide screens make long lines hard to read. Cap the editor around 70 characters per line and centre it, the way Notes and Mail do on iPad.

| Device | Folded | Unfolded |
| --- | --- | --- |
| iPhone Duo | compact | regular |
| iPad | regular | regular |

> A layout that only works at one width is a layout that breaks when you fold.
`;

const PROJECTS: SeedProject[] = [
  {
    name: "Cairn Mobile",
    description: "Foldable + iPad support for the mobile app",
    icon: "📱",
    priority: "high",
    notes: [
      { title: "Foldable layout research", folder: "Research", tags: ["research", "mobile"], content: LONG_NOTE },
      { title: "Split view spike", folder: "Research", tags: ["mobile"], content: "# Split view spike\n\nCompare `expo-router/unstable-split-view` with `@expo/ui` `NavigationSplitView`.\n\n- Routes keep working inside columns?\n- Fold/unfold keeps selection?\n" },
      { title: "Sidebar sketches", tags: ["design"], content: "# Sidebar sketches\n\nProjects, Calendar, Graph, Chat and Search as sidebar sections when wide." },
      { title: "Release checklist", content: "# Release checklist\n\n- [ ] Changelog\n- [ ] TestFlight\n- [ ] Screenshots for Duo + iPad" },
    ],
    cards: [
      { title: "Unlock orientation on iPhone", column: "todo", priority: "high", tags: ["mobile"] },
      { title: "Projects split view", column: "in_progress", priority: "high", dueInDays: 3, tags: ["mobile", "design"], description: "Sidebar → project → note/card, stacked when folded." },
      { title: "Chat two-column layout", column: "backlog", priority: "medium", tags: ["mobile"] },
      { title: "Readable width for note editor", column: "todo", priority: "medium", dueInDays: 7, tags: ["design"] },
      { title: "Board shows more columns when wide", column: "backlog", priority: "low" },
      { title: "Upgrade to Expo SDK 58 stable", column: "done", priority: "medium" },
      { title: "Fold/unfold keeps editor state", column: "review", priority: "urgent", dueInDays: 1, tags: ["bug"] },
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
  const note = db.getFirstSync<{ id: string }>("SELECT id FROM notes WHERE title = ?", "Foldable layout research");
  const card = db.getFirstSync<{ id: string }>("SELECT id FROM task_cards WHERE title = ?", "Projects split view");
  saveChatMessage({ role: "user", content: "Summarise the foldable research and update the split view task." });
  saveChatMessage({
    role: "assistant",
    content:
      "The research note argues for one tree with two layouts, keeping selection in state so folding never loses your place. I added that to the **Projects split view** task.",
    tools: [
      ...(note ? [{ tool: "get_note", ok: true, ref: { kind: "note" as const, id: note.id } }] : []),
      ...(card ? [{ tool: "update_task", ok: true, ref: { kind: "card" as const, id: card.id } }] : []),
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
      "Demo",
      "Local demo data (dev builds only)",
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
