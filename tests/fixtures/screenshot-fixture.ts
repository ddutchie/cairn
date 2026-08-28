/**
 * Cairn — Rich screenshot fixture (shared by Route A + B)
 * Deterministic, marketing-grade workspace: Cairn HQ with 3 workspaces, 10 notes, 20 cards, dense graph, automations, chat.
 */
export const WS_ID = "ws-cairn-hq";
export const PROJ_A = "proj-cairn-core";
export const PROJ_B = "proj-mobile";
export const PROJ_C = "proj-design-system";
export const TAG_BUG = "tag-bug";
export const TAG_FEAT = "tag-feature";
export const TAG_DOCS = "tag-docs";
export const TAG_RESEARCH = "tag-research";
export const TAG_DESIGN = "tag-design";
export const NOW = "2026-08-27T10:00:00.000Z";

const col = (id: string, projectId: string, name: string, type: string, order: number) => ({
  id, projectId, workspaceId: WS_ID, name, type, order, createdAt: NOW, updatedAt: NOW,
});

export const SCREENSHOT_SNAPSHOT = {
  workspaces: [
    { id: WS_ID, name: "Cairn HQ", description: "Marketing fixture", icon: "🗂️", createdAt: NOW, updatedAt: NOW },
  ],
  projects: [
    { id: PROJ_A, workspaceId: WS_ID, name: "Cairn — Personal Knowledge Base", description: "Core product", icon: "🧠", status: "active", priority: "high" as const, tagIds: [TAG_FEAT, TAG_DOCS], codeDirectory: "/tmp/cairn-demo", createdAt: NOW, updatedAt: NOW },
    { id: PROJ_B, workspaceId: WS_ID, name: "Mobile Companion", description: "iOS + Android", icon: "📱", status: "active", priority: "medium" as const, tagIds: [TAG_FEAT], codeDirectory: null, createdAt: NOW, updatedAt: NOW },
    { id: PROJ_C, workspaceId: WS_ID, name: "Design System", description: "Tokens & components", icon: "🎨", status: "active", priority: "medium" as const, tagIds: [TAG_DESIGN, TAG_DOCS], codeDirectory: null, createdAt: NOW, updatedAt: NOW },
  ],
  notes: [
    { id: "note-vision", projectId: PROJ_A, workspaceId: WS_ID, title: "Product Vision", content: "# Product Vision\n\nCairn is a local-first notes, tasks and agentic desktop app.\n\n- **Private by default** — everything stays on your machine\n- **AI that works with your data** — chat, coding agent, and automations\n- **Beautiful, fast** — a delight to open every day\n\n> [!NOTE]\n> Local-first means plain `.md` files you can read anywhere.", contentText: "Product Vision Cairn is a local-first notes tasks and agentic desktop app.", tagIds: [TAG_DOCS], linkedNoteIds: ["note-roadmap"], linkedCardIds: ["card-1"], isPinned: true, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-roadmap", projectId: PROJ_A, workspaceId: WS_ID, title: "Roadmap 2026", content: "# Roadmap 2026\n\n| Quarter | Focus |\n|---|---|\n| Q3 | Onboarding polish, sync engine |\n| Q4 | Mobile companion, shared workspaces |\n\n```ts\nconst ship = () => \"fast\";\n```\n\n- [x] Cordis runtime\n- [ ] Widget gallery", contentText: "Roadmap 2026 Q3 Onboarding polish", tagIds: [TAG_FEAT], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "Planning", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-agent", projectId: PROJ_A, workspaceId: WS_ID, title: "Agent Principles", content: "# Agent Principles\n\nThe built-in coding agent should feel like a teammate:\n\n1. Plan before acting\n2. Keep a clear todo list\n3. Prefer workspace conventions\n\n$E = mc^2$\n\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$", contentText: "Agent Principles Plan before acting", tagIds: [], linkedNoteIds: [], linkedCardIds: ["card-6"], isPinned: false, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-research", projectId: PROJ_A, workspaceId: WS_ID, title: "Meeting — User Research", content: "# User Research — May\n\n**Likes**\n- 'It finally understands my vault'\n- 'The agent reads my notes and just gets it'\n\n**Wants**\n- Cross-note AI summaries\n- Smarter automations", contentText: "User Research", tagIds: [TAG_RESEARCH], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "Research", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-canvas", projectId: PROJ_A, workspaceId: WS_ID, title: "Idea Canvas — Q3 Bets", content: "# Q3 Bets\n\nWe should double down on **offline AI** and **graph views**.", contentText: "Q3 Bets", tagIds: [TAG_FEAT], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-mobile", projectId: PROJ_B, workspaceId: WS_ID, title: "Mobile Spec", content: "# Mobile Spec\n\nAccess notes, board, chat from any phone on the local network.", contentText: "Mobile Spec", tagIds: [TAG_DESIGN], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-sync", projectId: PROJ_A, workspaceId: WS_ID, title: "Sync Engine RFC", content: "# Sync Engine RFC\n\nCRDT vs OT for offline-first sync. Propose Automerge + WAL.", contentText: "Sync Engine RFC CRDT", tagIds: [TAG_FEAT, TAG_RESEARCH], linkedNoteIds: ["note-roadmap"], linkedCardIds: ["card-2"], isPinned: false, type: "note" as const, folder: "RFC", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-embeddings", projectId: PROJ_A, workspaceId: WS_ID, title: "Embeddings Pipeline", content: "# Embeddings\n\nLocal transformer + onnxruntime for semantic search.", contentText: "Embeddings Pipeline", tagIds: [TAG_FEAT], linkedNoteIds: [], linkedCardIds: ["card-7"], isPinned: false, type: "note" as const, folder: "RFC", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-tokens", projectId: PROJ_C, workspaceId: WS_ID, title: "Design Tokens v2", content: "# Tokens v2\n\nSage #8faf6f is new default. Warm neutrals, stone palette.", contentText: "Design Tokens", tagIds: [TAG_DESIGN, TAG_DOCS], linkedNoteIds: [], linkedCardIds: ["card-13"], isPinned: true, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "note-metrics", projectId: PROJ_C, workspaceId: WS_ID, title: "Health Radar Spec", content: "# Health Radar\n\n6-axis radar: Done, Momentum, Focus, Knowledge, Flow, Calm.", contentText: "Health Radar", tagIds: [TAG_DESIGN], linkedNoteIds: [], linkedCardIds: ["card-14"], isPinned: false, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1 },
  ],
  columns: [
    col("col-a-backlog", PROJ_A, "Backlog", "backlog", 0),
    col("col-a-todo", PROJ_A, "To Do", "todo", 1),
    col("col-a-inprog", PROJ_A, "In Progress", "in_progress", 2),
    col("col-a-review", PROJ_A, "Review", "review", 3),
    col("col-a-done", PROJ_A, "Done", "done", 4),
    col("col-b-backlog", PROJ_B, "Backlog", "backlog", 0),
    col("col-b-todo", PROJ_B, "To Do", "todo", 1),
    col("col-b-done", PROJ_B, "Done", "done", 2),
    col("col-c-backlog", PROJ_C, "Backlog", "backlog", 0),
    col("col-c-todo", PROJ_C, "To Do", "todo", 1),
    col("col-c-done", PROJ_C, "Done", "done", 2),
  ],
  cards: [
    { id: "card-1", columnId: "col-a-backlog", projectId: PROJ_A, workspaceId: WS_ID, title: "Design the mobile companion app", description: "Figma + native sync", tagIds: [TAG_FEAT], priority: "high" as const, dueDate: null, linkedNoteIds: ["note-vision"], blockedByIds: [], order: 0, assignee: "Maya", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-2", columnId: "col-a-backlog", projectId: PROJ_A, workspaceId: WS_ID, title: "Evaluate embedded sync engine (CRDTs)", description: "", tagIds: [TAG_RESEARCH], priority: "medium" as const, dueDate: null, linkedNoteIds: ["note-sync"], blockedByIds: [], order: 1, assignee: null, createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-3", columnId: "col-a-backlog", projectId: PROJ_A, workspaceId: WS_ID, title: "Widget gallery — Publish, Metrics, Focus", description: "", tagIds: [TAG_FEAT], priority: "medium" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 2, assignee: "Leo", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-4", columnId: "col-a-todo", projectId: PROJ_A, workspaceId: WS_ID, title: "Ship the shared-workspaces beta", description: "", tagIds: [TAG_FEAT], priority: "high" as const, dueDate: "2026-09-01", linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-5", columnId: "col-a-todo", projectId: PROJ_A, workspaceId: WS_ID, title: "Write onboarding copy for new vaults", description: "", tagIds: [TAG_DOCS], priority: "medium" as const, dueDate: "2026-08-25", linkedNoteIds: [], blockedByIds: [], order: 1, assignee: null, createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-6", columnId: "col-a-inprog", projectId: PROJ_A, workspaceId: WS_ID, title: "Port the coding agent onto the Cordis runtime", description: "", tagIds: [TAG_FEAT], priority: "high" as const, dueDate: "2026-08-22", linkedNoteIds: ["note-agent"], blockedByIds: [], order: 0, assignee: "Sam", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-7", columnId: "col-a-inprog", projectId: PROJ_A, workspaceId: WS_ID, title: "Stream thinking blocks for the chat loop", description: "", tagIds: [TAG_FEAT], priority: "medium" as const, dueDate: "2026-08-21", linkedNoteIds: ["note-embeddings"], blockedByIds: [], order: 1, assignee: "Sam", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-8", columnId: "col-a-inprog", projectId: PROJ_A, workspaceId: WS_ID, title: "Add cross-note AI summaries", description: "", tagIds: [TAG_DOCS], priority: "medium" as const, dueDate: "2026-08-28", linkedNoteIds: ["note-canvas"], blockedByIds: ["card-6"], order: 2, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-9", columnId: "col-a-review", projectId: PROJ_A, workspaceId: WS_ID, title: "Verify the heartbeat automation runner", description: "", tagIds: [], priority: "high" as const, dueDate: "2026-08-20", linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Leo", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-10", columnId: "col-a-done", projectId: PROJ_A, workspaceId: WS_ID, title: "Local-first notes with markdown vaults", description: "", tagIds: [TAG_DOCS], priority: "low" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Maya", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-11", columnId: "col-a-done", projectId: PROJ_A, workspaceId: WS_ID, title: "Knowledge graph + insights canvases", description: "", tagIds: [TAG_FEAT], priority: "medium" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 1, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-12", columnId: "col-b-todo", projectId: PROJ_B, workspaceId: WS_ID, title: "Scan QR to pair device", description: "", tagIds: [TAG_DESIGN], priority: "high" as const, dueDate: "2026-08-30", linkedNoteIds: ["note-mobile"], blockedByIds: [], order: 0, assignee: null, createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-13", columnId: "col-c-todo", projectId: PROJ_C, workspaceId: WS_ID, title: "Ship Sage rebrand (#8faf6f)", description: "Update site + app accent", tagIds: [TAG_DESIGN], priority: "high" as const, dueDate: "2026-08-28", linkedNoteIds: ["note-tokens"], blockedByIds: [], order: 0, assignee: "Maya", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-14", columnId: "col-c-todo", projectId: PROJ_C, workspaceId: WS_ID, title: "Health radar polish", description: "6-axis radar for overview", tagIds: [TAG_DESIGN, TAG_FEAT], priority: "medium" as const, dueDate: "2026-08-25", linkedNoteIds: ["note-metrics"], blockedByIds: [], order: 1, assignee: "Leo", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-15", columnId: "col-c-backlog", projectId: PROJ_C, workspaceId: WS_ID, title: "Token studio — light/dark sync", description: "", tagIds: [TAG_DESIGN], priority: "medium" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-16", columnId: "col-a-backlog", projectId: PROJ_A, workspaceId: WS_ID, title: "Add plugin overlay slots", description: "app.overlay + statusbar", tagIds: [TAG_FEAT], priority: "low" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 3, assignee: "Sam", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-17", columnId: "col-a-todo", projectId: PROJ_A, workspaceId: WS_ID, title: "Light/dark site toggle", description: "Swap screenshots per theme", tagIds: [TAG_DESIGN, TAG_DOCS], priority: "high" as const, dueDate: "2026-08-27", linkedNoteIds: [], blockedByIds: [], order: 2, assignee: "Maya", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-18", columnId: "col-a-review", projectId: PROJ_A, workspaceId: WS_ID, title: "Deterministic screenshot harness", description: "Playwright + Electron", tagIds: [TAG_FEAT], priority: "medium" as const, dueDate: "2026-08-27", linkedNoteIds: [], blockedByIds: [], order: 1, assignee: "Leo", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-19", columnId: "col-c-done", projectId: PROJ_C, workspaceId: WS_ID, title: "Icon refresh — 72% fill", description: "Opaque + transparent", tagIds: [TAG_DESIGN], priority: "low" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Maya", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-20", columnId: "col-b-done", projectId: PROJ_B, workspaceId: WS_ID, title: "QR auth + PIN fallback", description: "Mobile companion", tagIds: [TAG_DESIGN], priority: "medium" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 1, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
  ],
  tags: [
    { id: TAG_BUG, name: "bug", color: "#ef4444", workspaceId: WS_ID },
    { id: TAG_FEAT, name: "feature", color: "#8faf6f", workspaceId: WS_ID },
    { id: TAG_DOCS, name: "docs", color: "#06b6d4", workspaceId: WS_ID },
    { id: TAG_RESEARCH, name: "research", color: "#f59e0b", workspaceId: WS_ID },
    { id: TAG_DESIGN, name: "design", color: "#b981d8", workspaceId: WS_ID },
  ],
};

export const SCREENSHOT_GRAPH = {
  nodes: [
    { id: PROJ_A, type: "project", title: "Cairn — Personal Knowledge Base", workspaceId: WS_ID },
    { id: PROJ_B, type: "project", title: "Mobile Companion", workspaceId: WS_ID },
    { id: PROJ_C, type: "project", title: "Design System", workspaceId: WS_ID },
    { id: "note-vision", type: "note", title: "Product Vision", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-roadmap", type: "note", title: "Roadmap 2026", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-agent", type: "note", title: "Agent Principles", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-research", type: "note", title: "Meeting — User Research", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-canvas", type: "note", title: "Idea Canvas — Q3 Bets", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-mobile", type: "note", title: "Mobile Spec", projectId: PROJ_B, workspaceId: WS_ID },
    { id: "note-sync", type: "note", title: "Sync Engine RFC", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-embeddings", type: "note", title: "Embeddings Pipeline", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-tokens", type: "note", title: "Design Tokens v2", projectId: PROJ_C, workspaceId: WS_ID },
    { id: "note-metrics", type: "note", title: "Health Radar Spec", projectId: PROJ_C, workspaceId: WS_ID },
    { id: "card-1", type: "card", title: "Design the mobile companion app", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-2", type: "card", title: "Evaluate embedded sync engine (CRDTs)", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-3", type: "card", title: "Widget gallery — Publish, Metrics, Focus", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-4", type: "card", title: "Ship the shared-workspaces beta", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-5", type: "card", title: "Write onboarding copy for new vaults", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-6", type: "card", title: "Port the coding agent onto the Cordis runtime", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-7", type: "card", title: "Stream thinking blocks for the chat loop", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-8", type: "card", title: "Add cross-note AI summaries", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-9", type: "card", title: "Verify the heartbeat automation runner", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-10", type: "card", title: "Local-first notes with markdown vaults", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-11", type: "card", title: "Knowledge graph + insights canvases", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "card-12", type: "card", title: "Scan QR to pair device", projectId: PROJ_B, workspaceId: WS_ID },
    { id: "card-13", type: "card", title: "Ship Sage rebrand (#8faf6f)", projectId: PROJ_C, workspaceId: WS_ID },
    { id: "card-14", type: "card", title: "Health radar polish", projectId: PROJ_C, workspaceId: WS_ID },
    { id: TAG_FEAT, type: "tag", title: "feature", workspaceId: WS_ID },
    { id: TAG_DOCS, type: "tag", title: "docs", workspaceId: WS_ID },
    { id: TAG_BUG, type: "tag", title: "bug", workspaceId: WS_ID },
    { id: TAG_RESEARCH, type: "tag", title: "research", workspaceId: WS_ID },
    { id: TAG_DESIGN, type: "tag", title: "design", workspaceId: WS_ID },
  ],
  edges: [
    { id: "e-p-n1", source: PROJ_A, target: "note-vision", type: "project-member" },
    { id: "e-p-n2", source: PROJ_A, target: "note-roadmap", type: "project-member" },
    { id: "e-p-n3", source: PROJ_A, target: "note-agent", type: "project-member" },
    { id: "e-p-n4", source: PROJ_A, target: "note-research", type: "project-member" },
    { id: "e-p-n5", source: PROJ_A, target: "note-canvas", type: "project-member" },
    { id: "e-p-n7", source: PROJ_A, target: "note-sync", type: "project-member" },
    { id: "e-p-n8", source: PROJ_A, target: "note-embeddings", type: "project-member" },
    { id: "e-pb-n6", source: PROJ_B, target: "note-mobile", type: "project-member" },
    { id: "e-pc-n9", source: PROJ_C, target: "note-tokens", type: "project-member" },
    { id: "e-pc-n10", source: PROJ_C, target: "note-metrics", type: "project-member" },
    { id: "e-p-c1", source: PROJ_A, target: "card-1", type: "project-member" },
    { id: "e-p-c2", source: PROJ_A, target: "card-2", type: "project-member" },
    { id: "e-p-c3", source: PROJ_A, target: "card-3", type: "project-member" },
    { id: "e-p-c4", source: PROJ_A, target: "card-4", type: "project-member" },
    { id: "e-p-c6", source: PROJ_A, target: "card-6", type: "project-member" },
    { id: "e-p-c7", source: PROJ_A, target: "card-7", type: "project-member" },
    { id: "e-p-c10", source: PROJ_A, target: "card-10", type: "project-member" },
    { id: "e-p-c16", source: PROJ_A, target: "card-16", type: "project-member" },
    { id: "e-p-c17", source: PROJ_A, target: "card-17", type: "project-member" },
    { id: "e-p-c18", source: PROJ_A, target: "card-18", type: "project-member" },
    { id: "e-pb-c12", source: PROJ_B, target: "card-12", type: "project-member" },
    { id: "e-pb-c20", source: PROJ_B, target: "card-20", type: "project-member" },
    { id: "e-pc-c13", source: PROJ_C, target: "card-13", type: "project-member" },
    { id: "e-pc-c14", source: PROJ_C, target: "card-14", type: "project-member" },
    { id: "e-pc-c15", source: PROJ_C, target: "card-15", type: "project-member" },
    { id: "e-nc-1", source: "note-vision", target: "card-1", type: "note-card" },
    { id: "e-nc-2", source: "note-agent", target: "card-6", type: "note-card" },
    { id: "e-nc-3", source: "note-canvas", target: "card-8", type: "note-card" },
    { id: "e-nc-4", source: "note-mobile", target: "card-12", type: "note-card" },
    { id: "e-nc-5", source: "note-sync", target: "card-2", type: "note-card" },
    { id: "e-nc-6", source: "note-embeddings", target: "card-7", type: "note-card" },
    { id: "e-nc-7", source: "note-tokens", target: "card-13", type: "note-card" },
    { id: "e-nc-8", source: "note-metrics", target: "card-14", type: "note-card" },
    { id: "e-nn-1", source: "note-vision", target: "note-roadmap", type: "note-note" },
    { id: "e-nn-2", source: "note-roadmap", target: "note-agent", type: "note-note" },
    { id: "e-nn-3", source: "note-agent", target: "note-research", type: "note-note" },
    { id: "e-nn-4", source: "note-canvas", target: "note-vision", type: "note-note" },
    { id: "e-nn-5", source: "note-sync", target: "note-embeddings", type: "note-note" },
    { id: "e-nn-6", source: "note-tokens", target: "note-metrics", type: "note-note" },
    { id: "e-c-t1", source: "card-1", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t2", source: "card-3", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t3", source: "card-4", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t4", source: "card-6", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t5", source: "card-11", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t6", source: "card-5", target: TAG_DOCS, type: "tag-member" },
    { id: "e-c-t7", source: "card-8", target: TAG_DOCS, type: "tag-member" },
    { id: "e-c-t8", source: "card-2", target: TAG_RESEARCH, type: "tag-member" },
    { id: "e-c-t9", source: "card-14", target: TAG_DESIGN, type: "tag-member" },
    { id: "e-c-t10", source: "card-13", target: TAG_DESIGN, type: "tag-member" },
    { id: "e-n-t1", source: "note-vision", target: TAG_DOCS, type: "tag-member" },
    { id: "e-n-t2", source: "note-roadmap", target: TAG_FEAT, type: "tag-member" },
    { id: "e-n-t3", source: "note-sync", target: TAG_RESEARCH, type: "tag-member" },
    { id: "e-n-t4", source: "note-tokens", target: TAG_DESIGN, type: "tag-member" },
    { id: "e-kw-1", source: "note-roadmap", target: "note-agent", type: "keyword" },
    { id: "e-kw-2", source: "note-vision", target: "note-canvas", type: "keyword" },
    { id: "e-kw-3", source: "note-sync", target: "note-embeddings", type: "keyword" },
    { id: "e-sem-1", source: "note-vision", target: "note-canvas", type: "semantic" },
    { id: "e-sem-2", source: "card-1", target: "card-3", type: "semantic" },
    { id: "e-sem-3", source: "note-tokens", target: "card-13", type: "semantic" },
    { id: "e-co-1", source: "card-6", target: "card-7", type: "co-mention" },
    { id: "e-co-2", source: "note-research", target: "card-8", type: "co-mention" },
    { id: "e-co-3", source: "card-13", target: "card-14", type: "co-mention" },
    { id: "e-assignee-1", source: "card-6", target: "card-7", type: "assignee" },
    { id: "e-assignee-2", source: "card-4", target: "card-8", type: "assignee" },
    { id: "e-assignee-3", source: "card-1", target: "card-10", type: "assignee" },
    { id: "e-assignee-4", source: "card-13", target: "card-19", type: "assignee" },
    { id: "e-wiki-1", source: "note-vision", target: "note-roadmap", type: "wikilink" },
    { id: "e-wiki-2", source: "note-sync", target: "note-vision", type: "wikilink" },
    { id: "e-card-dep", source: "card-6", target: "card-8", type: "co-mention" },
    { id: "e-card-dep2", source: "card-16", target: "card-17", type: "co-mention" },
  ],
};

export const SCREENSHOT_FLOW = {
  nodes: [
    { id: "fn-1", projectId: PROJ_A, type: "idea", data: { title: "Offline AI", body: "On-device Llama via llama.cpp — private, fast." }, x: 80, y: 80, width: 220, height: 90, createdAt: NOW, updatedAt: NOW },
    { id: "fn-2", projectId: PROJ_A, type: "idea", data: { title: "Graph views", body: "Force + Radial + 7 Insights canvases." }, x: 360, y: 80, width: 220, height: 90, createdAt: NOW, updatedAt: NOW },
    { id: "fn-3", projectId: PROJ_A, type: "note_ref", data: { noteId: "note-vision" }, x: 80, y: 220, width: 220, height: 72, createdAt: NOW, updatedAt: NOW },
    { id: "fn-4", projectId: PROJ_A, type: "task_ref", data: { cardId: "card-6" }, x: 360, y: 220, width: 220, height: 72, createdAt: NOW, updatedAt: NOW },
    { id: "fn-5", projectId: PROJ_A, type: "url", data: { url: "https://github.com/ggml-org/llama.cpp", title: "llama.cpp", description: "LLM inference in C/C++" }, x: 640, y: 80, width: 240, height: 90, createdAt: NOW, updatedAt: NOW },
    { id: "fn-g", projectId: PROJ_A, type: "group", data: { label: "Q3 Bets", color: "#8faf6f" }, x: 60, y: 60, width: 560, height: 280, createdAt: NOW, updatedAt: NOW },
    { id: "fn-ai", projectId: PROJ_A, type: "ai_summary", data: { content: "Focus on offline AI + graph views for Q3. They reinforce the local-first story and demo well." }, x: 640, y: 220, width: 240, height: 96, createdAt: NOW, updatedAt: NOW },
  ],
  edges: [
    { id: "fe-1", source: "fn-1", target: "fn-ai", label: "" },
    { id: "fe-2", source: "fn-2", target: "fn-ai", label: "" },
    { id: "fe-3", source: "fn-3", target: "fn-1", label: "" },
    { id: "fe-4", source: "fn-4", target: "fn-1", label: "implements" },
  ],
};

/**
 * Build the window.electron IPC mock string for the screenshot run.
 * Extends buildIpcMock with the richer SCREENSHOT_* fixtures.
 */
export function buildScreenshotMock(opts?: { needsWorkspaceSetup?: boolean }): string {
  const snapshot = JSON.stringify(SCREENSHOT_SNAPSHOT);
  const graph = JSON.stringify(SCREENSHOT_GRAPH);
  const flow = JSON.stringify(SCREENSHOT_FLOW);

  // Mock usage — realistic 30-day series so UsageView (cost page) is populated
  // in screenshots. Deterministic (anchored to NOW) so the PNGs don't flicker.
  const usageDay = (d: Date) => d.toISOString().slice(0, 10);
  const base = new Date(NOW);
  const series = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() - (29 - i));
    const prompt = 1800 + Math.round(Math.sin(i * 0.5) * 1200 + Math.random() * 800);
    const completion = 900 + Math.round(Math.cos(i * 0.7) * 800 + Math.random() * 600);
    const cost = Number((prompt * 0.000002 + completion * 0.000008 + (Math.random() * 0.15)).toFixed(2));
    return {
      day: usageDay(d),
      promptTokens: prompt,
      completionTokens: completion,
      reasoningTokens: Math.round(completion * 0.18),
      cacheReadTokens: Math.round(prompt * (0.15 + Math.random() * 0.2)),
      costUsd: cost,
      requests: 1 + (i % 3),
    };
  });
  const totals = series.reduce(
    (a, b) => ({
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      reasoningTokens: a.reasoningTokens + b.reasoningTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      costUsd: Number((a.costUsd + b.costUsd).toFixed(2)),
      requests: a.requests + b.requests,
    }),
    { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 0, requests: 0 },
  );
  const prevTotals = {
    promptTokens: Math.round(totals.promptTokens * 0.78),
    completionTokens: Math.round(totals.completionTokens * 0.74),
    reasoningTokens: Math.round(totals.reasoningTokens * 0.72),
    cacheReadTokens: Math.round(totals.cacheReadTokens * 0.65),
    costUsd: Number((totals.costUsd * 0.81).toFixed(2)),
    requests: Math.round(totals.requests * 0.82),
  };
  const usageOverview = {
    totals,
    previous: prevTotals,
    series,
    byModel: [
      { model: "gpt-5.6-luna", promptTokens: Math.round(totals.promptTokens * 0.45), completionTokens: Math.round(totals.completionTokens * 0.48), reasoningTokens: Math.round(totals.reasoningTokens * 0.5), cacheReadTokens: Math.round(totals.cacheReadTokens * 0.4), costUsd: Number((totals.costUsd * 0.48).toFixed(2)), requests: Math.round(totals.requests * 0.42) },
      { model: "claude-sonnet-4.5", promptTokens: Math.round(totals.promptTokens * 0.32), completionTokens: Math.round(totals.completionTokens * 0.3), reasoningTokens: Math.round(totals.reasoningTokens * 0.28), cacheReadTokens: Math.round(totals.cacheReadTokens * 0.35), costUsd: Number((totals.costUsd * 0.32).toFixed(2)), requests: Math.round(totals.requests * 0.33) },
      { model: "deepseek-v4-flash", promptTokens: Math.round(totals.promptTokens * 0.23), completionTokens: Math.round(totals.completionTokens * 0.22), reasoningTokens: Math.round(totals.reasoningTokens * 0.22), cacheReadTokens: Math.round(totals.cacheReadTokens * 0.25), costUsd: Number((totals.costUsd * 0.2).toFixed(2)), requests: Math.round(totals.requests * 0.25) },
    ],
    bySource: [
      { source: "chat", promptTokens: Math.round(totals.promptTokens * 0.5), completionTokens: Math.round(totals.completionTokens * 0.46), reasoningTokens: Math.round(totals.reasoningTokens * 0.4), cacheReadTokens: Math.round(totals.cacheReadTokens * 0.45), costUsd: Number((totals.costUsd * 0.46).toFixed(2)), requests: Math.round(totals.requests * 0.48) },
      { source: "coding-agent", promptTokens: Math.round(totals.promptTokens * 0.32), completionTokens: Math.round(totals.completionTokens * 0.34), reasoningTokens: Math.round(totals.reasoningTokens * 0.38), cacheReadTokens: Math.round(totals.cacheReadTokens * 0.32), costUsd: Number((totals.costUsd * 0.34).toFixed(2)), requests: Math.round(totals.requests * 0.32) },
      { source: "automation", promptTokens: Math.round(totals.promptTokens * 0.18), completionTokens: Math.round(totals.completionTokens * 0.2), reasoningTokens: Math.round(totals.reasoningTokens * 0.22), cacheReadTokens: Math.round(totals.cacheReadTokens * 0.23), costUsd: Number((totals.costUsd * 0.2).toFixed(2)), requests: Math.round(totals.requests * 0.2) },
    ],
  };
  const usageRecent = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() - Math.floor(i / 2));
    d.setHours(10 + (i % 8), (i * 7) % 60, 0, 0);
    const models = ["gpt-5.6-luna", "claude-sonnet-4.5", "deepseek-v4-flash"];
    const sources: Array<"chat" | "coding-agent" | "automation" | "chat-subagent"> = ["chat", "coding-agent", "chat-subagent", "automation"];
    const model = models[i % models.length];
    const source = sources[i % sources.length];
    const prompt = 800 + (i * 311) % 2400;
    const completion = 400 + (i * 197) % 1800;
    const cacheRead = i % 3 === 0 ? Math.round(prompt * 0.62) : 0;
    const cost = Number((prompt * 0.000002 + completion * 0.000008).toFixed(4));
    return {
      id: `ur-${String(i + 1).padStart(3, "0")}`,
      workspaceId: WS_ID,
      projectId: i % 2 === 0 ? PROJ_A : PROJ_B,
      source,
      sessionId: `sess-${i + 1}`,
      provider: model.startsWith("gpt") ? "openai" : model.startsWith("claude") ? "anthropic" : "deepseek",
      model,
      baseUrl: model.startsWith("gpt") ? "https://api.openai.com" : model.startsWith("claude") ? "https://api.anthropic.com" : "https://api.deepseek.com",
      promptTokens: prompt,
      completionTokens: completion,
      reasoningTokens: Math.round(completion * 0.18),
      cacheReadTokens: cacheRead,
      cacheCreationTokens: 0,
      costUsd: cost,
      costEstimated: i % 4 === 0,
      finishReason: "stop",
      createdAt: d.getTime(),
    };
  });
  const usageOverviewJson = JSON.stringify(usageOverview);
  const usageRecentJson = JSON.stringify(usageRecent);

  // Mock automations — 4 recipes with recent runs so Automations panels are populated
  const automations = [
    { id: "auto-morning", workspaceId: WS_ID, projectId: PROJ_A, name: "Morning Brief", description: "Daily standup digest", instructions: "Summarize yesterday's notes and today's due tasks", scheduleKind: "cron" as const, scheduleExpr: "0 8 * * 1-5", timezone: "America/New_York", nextRunAt: new Date(new Date(NOW).getTime() + 12 * 3600 * 1000).toISOString(), enabled: true, maxRuns: null, runCount: 42, approvalMode: "auto" as const, activeHoursStart: null, activeHoursEnd: null, standingRules: [], requires: [], env: [], source: "custom" as const, communityId: null, createdAt: NOW, updatedAt: NOW },
    { id: "auto-weekly", workspaceId: WS_ID, projectId: PROJ_A, name: "Weekly Review", description: "Friday retro + next week plan", instructions: "Collect completed cards and draft a retro note", scheduleKind: "cron" as const, scheduleExpr: "0 16 * * 5", timezone: "America/New_York", nextRunAt: new Date(new Date(NOW).getTime() + 3 * 24 * 3600 * 1000).toISOString(), enabled: true, maxRuns: null, runCount: 12, approvalMode: "ask" as const, activeHoursStart: "09:00", activeHoursEnd: "18:00", standingRules: [], requires: [], env: [], source: "community" as const, communityId: "weekly-review", createdAt: NOW, updatedAt: NOW },
    { id: "auto-pr", workspaceId: WS_ID, projectId: PROJ_A, name: "PR Inbox", description: "Every 6h — GitHub PR summary", instructions: "Fetch open PRs via the GitHub MCP and summarize blockers", scheduleKind: "every" as const, scheduleExpr: "every 6 hours", timezone: null, nextRunAt: new Date(new Date(NOW).getTime() + 2 * 3600 * 1000).toISOString(), enabled: true, maxRuns: null, runCount: 87, approvalMode: "auto" as const, activeHoursStart: null, activeHoursEnd: null, standingRules: [], requires: [{ kind: "mcp" as const, name: "GitHub" }], env: [], source: "community" as const, communityId: "github-pr-summary", createdAt: NOW, updatedAt: NOW },
    { id: "auto-research", workspaceId: WS_ID, projectId: PROJ_B, name: "Research Sync", description: "Hourly — Linear sprint digest", instructions: "Pull Linear issues and update the board", scheduleKind: "every" as const, scheduleExpr: "every 1 hours", timezone: null, nextRunAt: new Date(new Date(NOW).getTime() + 30 * 60 * 1000).toISOString(), enabled: false, maxRuns: 100, runCount: 8, approvalMode: "ask" as const, activeHoursStart: null, activeHoursEnd: null, standingRules: [], requires: [{ kind: "mcp" as const, name: "Linear" }], env: [], source: "custom" as const, communityId: null, createdAt: NOW, updatedAt: NOW },
  ];
  const automationRuns = [
    { id: "run-1", automationId: "auto-morning", status: "done" as const, resultNoteId: "note-research", startedAt: new Date(new Date(NOW).getTime() - 2 * 3600 * 1000).toISOString(), finishedAt: new Date(new Date(NOW).getTime() - 2 * 3600 * 1000 + 45 * 1000).toISOString(), error: null, scratch: null, createdAt: NOW, automationName: "Morning Brief", automationProjectId: PROJ_A },
    { id: "run-2", automationId: "auto-morning", status: "done" as const, resultNoteId: null, startedAt: new Date(new Date(NOW).getTime() - 26 * 3600 * 1000).toISOString(), finishedAt: new Date(new Date(NOW).getTime() - 26 * 3600 * 1000 + 38 * 1000).toISOString(), error: null, scratch: null, createdAt: NOW, automationName: "Morning Brief", automationProjectId: PROJ_A },
    { id: "run-3", automationId: "auto-weekly", status: "done" as const, resultNoteId: "note-metrics", startedAt: new Date(new Date(NOW).getTime() - 20 * 60 * 1000).toISOString(), finishedAt: new Date(new Date(NOW).getTime() - 20 * 60 * 1000 + 40 * 1000).toISOString(), error: null, scratch: "Done", createdAt: NOW, automationName: "Weekly Review", automationProjectId: PROJ_A },
    { id: "run-4", automationId: "auto-pr", status: "done" as const, resultNoteId: "note-sync", startedAt: new Date(new Date(NOW).getTime() - 5 * 3600 * 1000).toISOString(), finishedAt: new Date(new Date(NOW).getTime() - 5 * 3600 * 1000 + 22 * 1000).toISOString(), error: null, scratch: null, createdAt: NOW, automationName: "PR Inbox", automationProjectId: PROJ_A },
    { id: "run-5", automationId: "auto-pr", status: "error" as const, resultNoteId: null, startedAt: new Date(new Date(NOW).getTime() - 30 * 3600 * 1000).toISOString(), finishedAt: new Date(new Date(NOW).getTime() - 30 * 3600 * 1000 + 5 * 1000).toISOString(), error: "GitHub rate limit", scratch: null, createdAt: NOW, automationName: "PR Inbox", automationProjectId: PROJ_A },
  ];
  const automationsJson = JSON.stringify(automations);
  const automationRunsJson = JSON.stringify(automationRuns);

  // Chat — 2 threads with tool-call rich history so the drawer/panel looks alive
  const chatThreads = [
    { id: "t-1", scope: "project" as const, workspaceId: WS_ID, projectId: PROJ_A, title: "Summarize this project", createdAt: NOW, updatedAt: NOW },
    { id: "t-2", scope: "project" as const, workspaceId: WS_ID, projectId: PROJ_B, title: "Mobile auth flow", createdAt: NOW, updatedAt: NOW },
  ];
  const chatMessages: Record<string, Array<Record<string, unknown>>> = {
    "t-1": [
      { id: "m-1", threadId: "t-1", role: "user" as const, content: "Summarize this project.", createdAt: NOW },
      { id: "m-2", threadId: "t-1", role: "assistant" as const, content: "Cairn is a local-first PKM with notes, kanban, graph + insights. **Q3 focus:** offline AI + sync engine + Sage rebrand (#8faf6f). 20 cards across 3 projects, 10 notes, dense knowledge graph (38 nodes). Ship the screenshot harness next.", reasoning: "Checked project overview and recent notes…", toolCalls: [{ tool: "get_project_context_pack", label: "Read project context", ok: true, cairnRef: { type: "note" as const, id: "note-vision", title: "Product Vision" } }], createdAt: NOW },
      { id: "m-3", threadId: "t-1", role: "user" as const, content: "Create tasks from the Q3 bets note", createdAt: NOW },
      { id: "m-4", threadId: "t-1", role: "assistant" as const, content: "Created 2 tasks in **Cairn — Personal Knowledge Base** and linked them to `Idea Canvas — Q3 Bets`.", toolCalls: [{ tool: "create_card", label: "Create card", ok: true, cairnRef: { type: "task" as const, id: "card-8", title: "Add cross-note AI summaries" } }, { tool: "create_card", label: "Create card", ok: true, cairnRef: { type: "task" as const, id: "card-16", title: "Add plugin overlay slots" } }], createdAt: NOW },
    ],
    "t-2": [
      { id: "m-5", threadId: "t-2", role: "user" as const, content: "How does QR auth work?", createdAt: NOW },
      { id: "m-6", threadId: "t-2", role: "assistant" as const, content: "Scan the **Settings → Mobile** QR (or enter the 6-digit PIN). The phone pairs over your LAN — no cloud, no account. Try `Scan QR to pair device` on the board.", toolCalls: [{ tool: "read_note", label: "Read note", ok: true, cairnRef: { type: "note" as const, id: "note-mobile", title: "Mobile Spec" } }], createdAt: NOW },
    ],
  };
  const chatThreadsJson = JSON.stringify(chatThreads);
  const chatMessagesJson = JSON.stringify(chatMessages);

  const wsId = JSON.stringify(WS_ID);
  const projId = JSON.stringify(PROJ_A);
  const needsSetup = JSON.stringify(opts?.needsWorkspaceSetup ?? false);

  return /* js */ `
(function () {
  const snap = ${snapshot};
  const graphData = ${graph};
  const flowData = ${flow};
  const wsId = ${wsId};
  const projId = ${projId};
  const needsSetup = ${needsSetup};
  const usageOverviewData = ${usageOverviewJson};
  const usageRecentData = ${usageRecentJson};
  const automationsData = ${automationsJson};
  const automationRunsData = ${automationRunsJson};
  const chatThreadsData = ${chatThreadsJson};
  const chatMessagesData = ${chatMessagesJson};
  const noop = () => Promise.resolve(null);
  const __listeners = {};
  function makeListener(channel) {
    if (!__listeners[channel]) __listeners[channel] = new Set();
    return (cb) => { __listeners[channel].add(cb); return () => { __listeners[channel].delete(cb); }; };
  }
  window.__cairnEmit = (channel, payload) => {
    const set = __listeners[channel];
    if (!set) return 0;
    for (const cb of set) cb(payload);
    return set.size;
  };
  window.electron = {
    snapshot:              () => Promise.resolve(snap),
    hasData:               () => Promise.resolve(true),
    needsWorkspaceSetup:   () => Promise.resolve(needsSetup),
    workspace: { list: () => Promise.resolve(snap.workspaces), create: noop, update: noop },
    project:   { list: () => Promise.resolve(snap.projects),   create: noop, update: noop, delete: noop },
    note:      { list: () => Promise.resolve(snap.notes),      create: noop, update: noop, delete: noop, moveToFolder: noop, moveToProject: noop },
    column:    { list: () => Promise.resolve(snap.columns),    create: noop, update: noop, delete: noop },
    card:      { list: () => Promise.resolve(snap.cards),      create: noop, update: noop, delete: noop, addBlocker: noop, removeBlocker: noop, ready: () => Promise.resolve(snap.cards) },
    flow:      { get: () => Promise.resolve(flowData), node: { create: noop, update: noop, delete: noop, summarize: noop }, edge: { create: noop, delete: noop }, url: { fetch: () => Promise.resolve({ title: "", description: "" }) } },
    tag:       { list: () => Promise.resolve(snap.tags), create: noop, update: noop, delete: noop },
    chat:      { threads: (wid) => Promise.resolve(chatThreadsData.filter(t => !wid || t.workspaceId===wid)), sessionMessages: (tid) => Promise.resolve(chatMessagesData[tid] || []), upsertThread: noop, deleteThread: noop, clearThreadMessages: noop, clearAllThreads: noop, stream: () => {}, abort: () => {}, onToken: makeListener("chat.onToken"), onDone: makeListener("chat.onDone"), onToolCall: makeListener("chat.onToolCall"), onToolCallDone: makeListener("chat.onToolCallDone"), onUsage: makeListener("chat.onUsage") },
    usage:     { overview: () => Promise.resolve(usageOverviewData), recent: () => Promise.resolve(usageRecentData), clear: () => Promise.resolve({ deleted: 0, ok: true }) },
    automation: { list: (wid) => Promise.resolve(automationsData.filter(a => !wid || a.workspaceId===wid)), get: (id) => Promise.resolve(automationsData.find(a=>a.id===id) || null), create: noop, update: (id,patch) => Promise.resolve(Object.assign({}, automationsData.find(a=>a.id===id) || {}, patch, { id })), delete: noop, runs: (aid, lim) => Promise.resolve(automationRunsData.filter(r=>r.automationId===aid).slice(0, lim||20)), recentRuns: (wid, pid, lim) => Promise.resolve(automationRunsData.filter(r=> !wid || automationsData.find(a=>a.id===r.automationId)?.workspaceId===wid).slice(0, lim||8)), runNow: (id) => Promise.resolve({ runId: "run-now-" + id }), runningCount: () => Promise.resolve(automationRunsData.filter(r=>r.status==="running").length), onRunEvent: makeListener("automation:run"), env: { get: () => Promise.resolve([]), set: () => Promise.resolve([]), delete: () => Promise.resolve([]) }, checkRequirements: () => Promise.resolve([]), preview: () => Promise.resolve({ nextRunAt: new Date(Date.now()+3600*1000).toISOString() }) },
    graph:     { get: () => Promise.resolve(graphData), neighbors: () => Promise.resolve({ nodes: [], edges: [] }), recompute: noop },
    ai:        { generatePrd: noop },
    mcpServerPath: () => Promise.resolve("/mock/mcp-server"), latestChangelog: () => Promise.resolve(null),
    revealNote: noop, openExternal: () => {}, uploadAsset: () => Promise.resolve({ assetUrl: "" }), revealAssets: noop,
    selectWorkspaceFolder: () => Promise.resolve(null), getWorkspacePath: () => Promise.resolve("/mock/workspace"),
    needsWorkspaceSetup: () => Promise.resolve(needsSetup), setTheme: noop, setAccent: noop, initWorkspace: () => Promise.resolve({ ok: true }),
    rescanWorkspace: () => Promise.resolve({ projectsCreated: 0, createdProjects: [] }),
    probeWorkspaceFolder: () => Promise.resolve({ isObsidianVault: false, vaultName: "Notes", noteCount: 0, skippedCount: 0, projects: [], excludedFolders: [] }),
    relaunch: noop, resetAllData: noop, platform: "darwin",
    updater: { onUpdateAvailable: makeListener("updater.onUpdateAvailable"), onUpdateDownloaded: makeListener("updater.onUpdateDownloaded"), install: noop },
    onDbChanged: makeListener("onDbChanged"), onMcpUnreadCount: makeListener("onMcpUnreadCount"), markMcpNotificationsRead: noop,
    onAiWriteStarted: makeListener("onAiWriteStarted"), onAiWriteEnded: makeListener("onAiWriteEnded"),
    mcpQuery: (_tool, _args) => Promise.resolve(null),
    agent: { getCodingAgents: () => Promise.resolve([]), saveCodingAgent: noop, deleteCodingAgent: noop, setDefaultAgent: noop, readDir: () => Promise.resolve([]), readFile: () => Promise.resolve(""), readFileBase64: () => Promise.resolve(""), writeFile: noop, validateDirectory: () => Promise.resolve(true), gitDiff: () => Promise.resolve(""), pickDirectory: () => Promise.resolve(null), pickFile: () => Promise.resolve(null), spawn: () => Promise.resolve({ sessionId: "mock-session" }), input: noop, resize: noop, spawnShell: () => Promise.resolve({ sessionId: "mock-shell-session" }), kill: () => Promise.resolve(), onData: makeListener("agent.onData"), onExit: makeListener("agent.onExit") },
    session: { prompt: noop, onEvent: makeListener("session:onEvent"), onProjection: makeListener("session:onProjection"), contextRing: () => Promise.resolve({ available: false }), runningIds: () => Promise.resolve({ ids: [] }), setMode: noop, respondTool: noop, compactNow: noop, isRunning: () => Promise.resolve(false), abort: noop, clear: noop, destroy: noop, approvePlan: noop, restoreContext: noop, listSessions: () => Promise.resolve([]), createSession: noop, deleteSession: noop, getSessionMessages: () => Promise.resolve([]), getTodos: () => Promise.resolve([]), respondQuestions: noop },
    tools: { listMcpServers: () => Promise.resolve([]), saveMcpServer: noop, deleteMcpServer: noop, testMcp: () => Promise.resolve({ ok: true, toolCount: 0, toolNames: [] }), listMcpTools: () => Promise.resolve({ ok: true, tools: [] }), listServices: () => Promise.resolve([]), saveService: noop, deleteService: noop, testService: () => Promise.resolve({ ok: true }), listAttachments: () => Promise.resolve([]), setAttachment: noop, clearAttachment: noop, startMcpAuth: () => Promise.resolve({ status: "already_authorized" }), mcpAuthStatus: () => Promise.resolve({ connected: false }), signOutMcp: noop, cancelMcpAuth: () => Promise.resolve({ cancelled: false }), startServiceAuth: () => Promise.resolve({ status: "already_authorized" }), serviceAuthStatus: () => Promise.resolve({ connected: false }), signOutService: noop, cancelServiceAuth: () => Promise.resolve({ cancelled: false }), onOauthCallback: makeListener("tools.onOauthCallback") },
    secrets: { available: () => Promise.resolve(false), set: () => Promise.resolve(""), has: () => Promise.resolve(false), delete: noop },
    toolBuilder: { prompt: () => {}, abort: () => {}, end: () => {}, onToken: makeListener("toolBuilder.onToken"), onStep: makeListener("toolBuilder.onStep"), onProbeHost: makeListener("toolBuilder.onProbeHost"), onProposal: makeListener("toolBuilder.onProposal"), onDone: makeListener("toolBuilder.onDone") },
    notification: { list: () => Promise.resolve([]), count: () => Promise.resolve(0), markRead: noop, markAllRead: noop, clear: noop },
  };
})();
`;
}
