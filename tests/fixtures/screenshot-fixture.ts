/**
 * Cairn — Rich screenshot fixture (shared by Route A + B)
 *
 * Deterministic, marketing-grade workspace: Cairn HQ with 1 workspace, 2
 * projects, ~6 notes with markdown variety, 12 cards across columns with
 * priorities/due dates, tags, linked notes, flow graph, and knowledge graph.
 *
 * Extends the smoke FIXTURE_SNAPSHOT shape so the IPC mock (`buildScreenshotMock`)
 * can return it directly. No LLM calls required.
 */

export const WS_ID = "ws-cairn-hq";
export const PROJ_A = "proj-cairn-core";
export const PROJ_B = "proj-mobile";
export const TAG_BUG = "tag-bug";
export const TAG_FEAT = "tag-feature";
export const TAG_DOCS = "tag-docs";
export const NOW = "2026-08-27T10:00:00.000Z";

const col = (id: string, projectId: string, name: string, type: string, order: number) => ({
  id, projectId, workspaceId: WS_ID, name, type, order, createdAt: NOW, updatedAt: NOW,
});

export const SCREENSHOT_SNAPSHOT = {
  workspaces: [
    { id: WS_ID, name: "Cairn HQ", description: "Marketing fixture", icon: "🗂️", createdAt: NOW, updatedAt: NOW },
  ],
  projects: [
    {
      id: PROJ_A, workspaceId: WS_ID, name: "Cairn — Personal Knowledge Base", description: "Core product", icon: "🧠",
      status: "active", priority: "high" as const, tagIds: [TAG_FEAT, TAG_DOCS], codeDirectory: "/tmp/cairn-demo", createdAt: NOW, updatedAt: NOW,
    },
    {
      id: PROJ_B, workspaceId: WS_ID, name: "Mobile Companion", description: "iOS + Android", icon: "📱",
      status: "active", priority: "medium" as const, tagIds: [TAG_FEAT], codeDirectory: null, createdAt: NOW, updatedAt: NOW,
    },
  ],
  notes: [
    {
      id: "note-vision", projectId: PROJ_A, workspaceId: WS_ID, title: "Product Vision",
      content: "# Product Vision\n\nCairn is a local-first notes, tasks and agentic desktop app.\n\n- **Private by default** — everything stays on your machine\n- **AI that works with your data** — chat, coding agent, and automations\n- **Beautiful, fast** — a delight to open every day\n\n> [!NOTE]\n> Local-first means plain `.md` files you can read anywhere.",
      contentText: "Product Vision Cairn is a local-first notes tasks and agentic desktop app.",
      tagIds: [TAG_DOCS], linkedNoteIds: ["note-roadmap"], linkedCardIds: ["card-1"], isPinned: true, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1,
    },
    {
      id: "note-roadmap", projectId: PROJ_A, workspaceId: WS_ID, title: "Roadmap 2026",
      content: "# Roadmap 2026\n\n| Quarter | Focus |\n|---|---|\n| Q3 | Onboarding polish, sync engine |\n| Q4 | Mobile companion, shared workspaces |\n\n```ts\nconst ship = () => \"fast\";\n```\n\n- [x] Cordis runtime\n- [ ] Widget gallery",
      contentText: "Roadmap 2026 Q3 Onboarding polish", tagIds: [TAG_FEAT], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "Planning", createdAt: NOW, updatedAt: NOW, version: 1,
    },
    {
      id: "note-agent", projectId: PROJ_A, workspaceId: WS_ID, title: "Agent Principles",
      content: "# Agent Principles\n\nThe built-in coding agent should feel like a teammate:\n\n1. Plan before acting\n2. Keep a clear todo list\n3. Prefer workspace conventions\n\n$E = mc^2$\n\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$",
      contentText: "Agent Principles Plan before acting", tagIds: [], linkedNoteIds: [], linkedCardIds: ["card-6"], isPinned: false, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1,
    },
    {
      id: "note-research", projectId: PROJ_A, workspaceId: WS_ID, title: "Meeting — User Research",
      content: "# User Research — May\n\n**Likes**\n- 'It finally understands my vault'\n- 'The agent reads my notes and just gets it'\n\n**Wants**\n- Cross-note AI summaries\n- Smarter automations",
      contentText: "User Research", tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "Research", createdAt: NOW, updatedAt: NOW, version: 1,
    },
    {
      id: "note-canvas", projectId: PROJ_A, workspaceId: WS_ID, title: "Idea Canvas — Q3 Bets",
      content: "# Q3 Bets\n\nWe should double down on **offline AI** and **graph views**.", contentText: "Q3 Bets", tagIds: [TAG_FEAT], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1,
    },
    {
      id: "note-mobile", projectId: PROJ_B, workspaceId: WS_ID, title: "Mobile Spec",
      content: "# Mobile Spec\n\nAccess notes, board, chat from any phone on the local network.", contentText: "Mobile Spec", tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note" as const, folder: "", createdAt: NOW, updatedAt: NOW, version: 1,
    },
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
  ],
  cards: [
    { id: "card-1", columnId: "col-a-backlog", projectId: PROJ_A, workspaceId: WS_ID, title: "Design the mobile companion app", description: "Figma + native sync", tagIds: [TAG_FEAT], priority: "high" as const, dueDate: null, linkedNoteIds: ["note-vision"], blockedByIds: [], order: 0, assignee: "Maya", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-2", columnId: "col-a-backlog", projectId: PROJ_A, workspaceId: WS_ID, title: "Evaluate embedded sync engine (CRDTs)", description: "", tagIds: [], priority: "medium" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 1, assignee: null, createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-3", columnId: "col-a-backlog", projectId: PROJ_A, workspaceId: WS_ID, title: "Widget gallery — Publish, Metrics, Focus", description: "", tagIds: [TAG_FEAT], priority: "medium" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 2, assignee: "Leo", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-4", columnId: "col-a-todo", projectId: PROJ_A, workspaceId: WS_ID, title: "Ship the shared-workspaces beta", description: "", tagIds: [TAG_FEAT], priority: "high" as const, dueDate: "2026-09-01", linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-5", columnId: "col-a-todo", projectId: PROJ_A, workspaceId: WS_ID, title: "Write onboarding copy for new vaults", description: "", tagIds: [TAG_DOCS], priority: "medium" as const, dueDate: "2026-08-25", linkedNoteIds: [], blockedByIds: [], order: 1, assignee: null, createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-6", columnId: "col-a-inprog", projectId: PROJ_A, workspaceId: WS_ID, title: "Port the coding agent onto the Cordis runtime", description: "", tagIds: [TAG_FEAT], priority: "high" as const, dueDate: "2026-08-22", linkedNoteIds: ["note-agent"], blockedByIds: [], order: 0, assignee: "Sam", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-7", columnId: "col-a-inprog", projectId: PROJ_A, workspaceId: WS_ID, title: "Stream thinking blocks for the chat loop", description: "", tagIds: [], priority: "medium" as const, dueDate: "2026-08-21", linkedNoteIds: [], blockedByIds: [], order: 1, assignee: "Sam", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-8", columnId: "col-a-inprog", projectId: PROJ_A, workspaceId: WS_ID, title: "Add cross-note AI summaries", description: "", tagIds: [TAG_DOCS], priority: "medium" as const, dueDate: "2026-08-28", linkedNoteIds: ["note-canvas"], blockedByIds: ["card-6"], order: 2, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-9", columnId: "col-a-review", projectId: PROJ_A, workspaceId: WS_ID, title: "Verify the heartbeat automation runner", description: "", tagIds: [], priority: "high" as const, dueDate: "2026-08-20", linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Leo", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-10", columnId: "col-a-done", projectId: PROJ_A, workspaceId: WS_ID, title: "Local-first notes with markdown vaults", description: "", tagIds: [], priority: "low" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 0, assignee: "Maya", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-11", columnId: "col-a-done", projectId: PROJ_A, workspaceId: WS_ID, title: "Knowledge graph + insights canvases", description: "", tagIds: [TAG_FEAT], priority: "medium" as const, dueDate: null, linkedNoteIds: [], blockedByIds: [], order: 1, assignee: "Aria", createdAt: NOW, updatedAt: NOW, version: 1 },
    { id: "card-12", columnId: "col-b-todo", projectId: PROJ_B, workspaceId: WS_ID, title: "Scan QR to pair device", description: "", tagIds: [], priority: "high" as const, dueDate: "2026-08-30", linkedNoteIds: ["note-mobile"], blockedByIds: [], order: 0, assignee: null, createdAt: NOW, updatedAt: NOW, version: 1 },
  ],
  tags: [
    { id: TAG_BUG, name: "bug", color: "#ef4444", workspaceId: WS_ID },
    { id: TAG_FEAT, name: "feature", color: "#7c6af7", workspaceId: WS_ID },
    { id: TAG_DOCS, name: "docs", color: "#06b6d4", workspaceId: WS_ID },
  ],
};

export const SCREENSHOT_GRAPH = {
  // Rich graph — 23 nodes (≈6 notes + 12 cards + 2 projects + 3 tags) and ~34 edges
  // so the force layout shows dense clusters and hulls instead of a sparse demo.
  nodes: [
    { id: PROJ_A, type: "project", title: "Cairn — Personal Knowledge Base", workspaceId: WS_ID },
    { id: PROJ_B, type: "project", title: "Mobile Companion", workspaceId: WS_ID },
    { id: "note-vision", type: "note", title: "Product Vision", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-roadmap", type: "note", title: "Roadmap 2026", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-agent", type: "note", title: "Agent Principles", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-research", type: "note", title: "Meeting — User Research", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-canvas", type: "note", title: "Idea Canvas — Q3 Bets", projectId: PROJ_A, workspaceId: WS_ID },
    { id: "note-mobile", type: "note", title: "Mobile Spec", projectId: PROJ_B, workspaceId: WS_ID },
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
    { id: TAG_FEAT, type: "tag", title: "feature", workspaceId: WS_ID },
    { id: TAG_DOCS, type: "tag", title: "docs", workspaceId: WS_ID },
    { id: TAG_BUG, type: "tag", title: "bug", workspaceId: WS_ID },
  ],
  edges: [
    // project membership — every entity belongs to a project (hulls in force layout)
    { id: "e-p-n1", source: PROJ_A, target: "note-vision", type: "project-member" },
    { id: "e-p-n2", source: PROJ_A, target: "note-roadmap", type: "project-member" },
    { id: "e-p-n3", source: PROJ_A, target: "note-agent", type: "project-member" },
    { id: "e-p-n4", source: PROJ_A, target: "note-research", type: "project-member" },
    { id: "e-p-n5", source: PROJ_A, target: "note-canvas", type: "project-member" },
    { id: "e-pb-n6", source: PROJ_B, target: "note-mobile", type: "project-member" },
    { id: "e-p-c1", source: PROJ_A, target: "card-1", type: "project-member" },
    { id: "e-p-c2", source: PROJ_A, target: "card-2", type: "project-member" },
    { id: "e-p-c3", source: PROJ_A, target: "card-3", type: "project-member" },
    { id: "e-p-c4", source: PROJ_A, target: "card-4", type: "project-member" },
    { id: "e-p-c6", source: PROJ_A, target: "card-6", type: "project-member" },
    { id: "e-p-c7", source: PROJ_A, target: "card-7", type: "project-member" },
    { id: "e-p-c10", source: PROJ_A, target: "card-10", type: "project-member" },
    { id: "e-pb-c12", source: PROJ_B, target: "card-12", type: "project-member" },
    // note ↔ card / note ↔ note (explicit links)
    { id: "e-nc-1", source: "note-vision", target: "card-1", type: "note-card" },
    { id: "e-nc-2", source: "note-agent", target: "card-6", type: "note-card" },
    { id: "e-nc-3", source: "note-canvas", target: "card-8", type: "note-card" },
    { id: "e-nc-4", source: "note-mobile", target: "card-12", type: "note-card" },
    { id: "e-nn-1", source: "note-vision", target: "note-roadmap", type: "note-note" },
    { id: "e-nn-2", source: "note-roadmap", target: "note-agent", type: "note-note" },
    { id: "e-nn-3", source: "note-agent", target: "note-research", type: "note-note" },
    { id: "e-nn-4", source: "note-canvas", target: "note-vision", type: "note-note" },
    // tag membership
    { id: "e-c-t1", source: "card-1", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t2", source: "card-3", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t3", source: "card-4", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t4", source: "card-6", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t5", source: "card-11", target: TAG_FEAT, type: "tag-member" },
    { id: "e-c-t6", source: "card-5", target: TAG_DOCS, type: "tag-member" },
    { id: "e-c-t7", source: "card-8", target: TAG_DOCS, type: "tag-member" },
    { id: "e-n-t1", source: "note-vision", target: TAG_DOCS, type: "tag-member" },
    { id: "e-n-t2", source: "note-roadmap", target: TAG_FEAT, type: "tag-member" },
    // auto-discovered edges — keyword / semantic / co-mention / assignee / wikilink
    { id: "e-kw-1", source: "note-roadmap", target: "note-agent", type: "keyword" },
    { id: "e-kw-2", source: "note-vision", target: "note-canvas", type: "keyword" },
    { id: "e-sem-1", source: "note-vision", target: "note-canvas", type: "semantic" },
    { id: "e-sem-2", source: "card-1", target: "card-3", type: "semantic" },
    { id: "e-co-1", source: "card-6", target: "card-7", type: "co-mention" },
    { id: "e-co-2", source: "note-research", target: "card-8", type: "co-mention" },
    { id: "e-assignee-1", source: "card-6", target: "card-7", type: "assignee" },
    { id: "e-assignee-2", source: "card-4", target: "card-8", type: "assignee" },
    { id: "e-assignee-3", source: "card-1", target: "card-10", type: "assignee" },
    { id: "e-wiki-1", source: "note-vision", target: "note-roadmap", type: "wikilink" },
    { id: "e-card-dep", source: "card-6", target: "card-8", type: "co-mention" },
  ],
};

export const SCREENSHOT_FLOW = {
  nodes: [
    { id: "fn-1", projectId: PROJ_A, type: "idea", data: { title: "Offline AI", body: "On-device Llama via llama.cpp — private, fast." }, x: 80, y: 80, width: 220, height: 90, createdAt: NOW, updatedAt: NOW },
    { id: "fn-2", projectId: PROJ_A, type: "idea", data: { title: "Graph views", body: "Force + Radial + 7 Insights canvases." }, x: 360, y: 80, width: 220, height: 90, createdAt: NOW, updatedAt: NOW },
    { id: "fn-3", projectId: PROJ_A, type: "note_ref", data: { noteId: "note-vision" }, x: 80, y: 220, width: 220, height: 72, createdAt: NOW, updatedAt: NOW },
    { id: "fn-4", projectId: PROJ_A, type: "task_ref", data: { cardId: "card-6" }, x: 360, y: 220, width: 220, height: 72, createdAt: NOW, updatedAt: NOW },
    { id: "fn-5", projectId: PROJ_A, type: "url", data: { url: "https://github.com/ggml-org/llama.cpp", title: "llama.cpp", description: "LLM inference in C/C++" }, x: 640, y: 80, width: 240, height: 90, createdAt: NOW, updatedAt: NOW },
    { id: "fn-g", projectId: PROJ_A, type: "group", data: { label: "Q3 Bets", color: "#7c6af7" }, x: 60, y: 60, width: 560, height: 280, createdAt: NOW, updatedAt: NOW },
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

  // Inline a minimal version of buildIpcMock with screenshot fixtures swapped in
  // (we re-use the same channel shape so the app hydrates identically).
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
    chat:      { threads: () => Promise.resolve([{ id:"t-1", projectId: projId, workspaceId: wsId, title:"Summarize this project", createdAt: "${NOW}", updatedAt: "${NOW}" }]), messages: () => Promise.resolve([{ id:"m-1", threadId:"t-1", role:"user", content:"Summarize this project.", createdAt:"${NOW}" },{ id:"m-2", threadId:"t-1", role:"assistant", content:"Cairn is a local-first PKM with notes, kanban, graph + insights. Ship Q3: offline AI + sync engine.", createdAt:"${NOW}" }]), upsertThread: noop, addMessage: noop, deleteThread: noop, stream: () => {}, abort: () => {}, onToken: makeListener("chat.onToken"), onDone: makeListener("chat.onDone"), onToolCall: makeListener("chat.onToolCall"), onToolCallDone: makeListener("chat.onToolCallDone"), onUsage: makeListener("chat.onUsage") },
    usage:     { overview: () => Promise.resolve(${usageOverviewJson}), recent: () => Promise.resolve(${usageRecentJson}), clear: () => Promise.resolve({ deleted: 0, ok: true }) },
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
    session: { prompt: noop, onEvent: makeListener("session:onEvent"), onProjection: makeListener("session:onProjection"), contextRing: () => Promise.resolve({ available: false }), runningIds: () => Promise.resolve({ ids: [] }), setMode: noop, respondTool: noop, compactNow: noop, isRunning: () => Promise.resolve(false), abort: noop, clear: noop, destroy: noop, approvePlan: noop, restoreContext: noop, listSessions: () => Promise.resolve([]), createSession: noop, deleteSession: noop, getMessages: () => Promise.resolve([]), getTodos: () => Promise.resolve([]), saveMessages: noop, onToken: makeListener("piAgent.onToken"), onTool: makeListener("piAgent.onTool"), onDone: makeListener("piAgent.onDone"), onError: makeListener("piAgent.onError"), onToolsReady: makeListener("piAgent.onToolsReady"), onStep: makeListener("piAgent.onStep"), onUsage: makeListener("piAgent.onUsage"), onSubagent: makeListener("piAgent.onSubagent"), onSubagentToken: makeListener("piAgent.onSubagentToken"), onSubagentThought: makeListener("piAgent.onSubagentThought"), onSubagentToolCall: makeListener("piAgent.onSubagentToolCall"), onSubagentToolCallDone: makeListener("piAgent.onSubagentToolCallDone"), onSubagentUsage: makeListener("piAgent.onSubagentUsage"), onAskQuestions: makeListener("piAgent.onAskQuestions"), respondQuestions: noop, onPlanNote: makeListener("piAgent.onPlanNote"), onNoteUpdated: makeListener("piAgent.onNoteUpdated"), onModeChange: makeListener("piAgent.onModeChange") },
    tools: { listMcpServers: () => Promise.resolve([]), saveMcpServer: noop, deleteMcpServer: noop, testMcp: () => Promise.resolve({ ok: true, toolCount: 0, toolNames: [] }), listMcpTools: () => Promise.resolve({ ok: true, tools: [] }), listServices: () => Promise.resolve([]), saveService: noop, deleteService: noop, testService: () => Promise.resolve({ ok: true }), listAttachments: () => Promise.resolve([]), setAttachment: noop, clearAttachment: noop, startMcpAuth: () => Promise.resolve({ status: "already_authorized" }), mcpAuthStatus: () => Promise.resolve({ connected: false }), signOutMcp: noop, cancelMcpAuth: () => Promise.resolve({ cancelled: false }), startServiceAuth: () => Promise.resolve({ status: "already_authorized" }), serviceAuthStatus: () => Promise.resolve({ connected: false }), signOutService: noop, cancelServiceAuth: () => Promise.resolve({ cancelled: false }), onOauthCallback: makeListener("tools.onOauthCallback") },
    secrets: { available: () => Promise.resolve(false), set: () => Promise.resolve(""), has: () => Promise.resolve(false), delete: noop },
    toolBuilder: { prompt: () => {}, abort: () => {}, end: () => {}, onToken: makeListener("toolBuilder.onToken"), onStep: makeListener("toolBuilder.onStep"), onProbeHost: makeListener("toolBuilder.onProbeHost"), onProposal: makeListener("toolBuilder.onProposal"), onDone: makeListener("toolBuilder.onDone") },
  };
})();
`;
}
