# Mobile vs desktop parity matrix

Status: audit, 2026-11-21. Rewritten 2026-11-22 after PRs 335, 336 and 338: every feature now has its own matrix, and each open row says what blocks it and roughly how big it is.
Source: the desktop view list (`scripts/export-site-data.js`), `settings-index.ts`, `src/components/*`, `TOOL_SCHEMAS`, `shared/sync/schema.ts`, and the mobile `app/` routes, `src/screens`, `src/components`, `src/db`, `src/chat/tools.ts`. Rows were judged from the code, not by running the app.

Legend: **Yes** = same job done; **Partial** = some of it; **No** = not on mobile; **n/a** = does not belong on a phone. Size: **S** = a screen or sheet over code that already exists (shared or mobile); **M** = new queries or a ported module; **L** = needs a sync or desktop change first.

## What decides the order: what syncs

The phone only has what `SYNCABLE_TABLES` (`shared/sync/schema.ts`) replicates: workspaces, projects, board columns, tags, notes, tasks, people, teams, memberships, person edges, meetings, attendees, note mentions, user style and attachments.

Not synced, so **L** on mobile until a sync change lands:

| Desktop data | Where it lives | Blocks |
|---|---|---|
| Idea Flow (`idea_flows`, `idea_flow_nodes`, `idea_flow_edges`) | DB, device-local | Idea Flow view, `get_idea_flow` / `edit_idea_flow`, flow edges in the graph |
| Today brief, marks, history | JSON files under the Today automation's output folder (`electron/lib/today-files.ts`) | Today's AI lanes on the phone |
| Automations, runs, notifications | DB, device-local (schema v32) | Automations list, notification feed |
| Custom and community slash commands (`slash_commands`) | DB, device-local (schema v31, "not user data") | Your own commands in a mobile `/` picker. The built-in chat commands are constants in `src/lib/slash-commands.ts` and could move to `shared/` |
| Chat threads | Deliberately device-local on both sides | Nothing: by design |

Everything else in this document is **S** or **M**: the data is already on the phone.

## Overview

| Desktop | Mobile | Migrate? |
|---|---|---|
| Project overview (progress, health radar, summary) | Yes: Overview tab, `HealthRadar`, `ProgressRing` | done |
| Workspace progress | Yes: progress card on Projects, widget | done |
| Create project | Yes: New project in the Projects menu and on the empty Projects screen (`app/project-form.tsx`); default columns from `shared/projects/defaults.ts` | done |
| Edit project (name, description, icon, status, priority) | Yes: Edit project on the project toolbar; `upsert_project` in chat. A rename from the phone moves the desktop's notes folder during sync (`reconcileProjectFolders` in the applied-rows hook) | done |
| Archive or delete project | No (chat `delete` can delete one) | Medium, S once edit exists |

## Notes

| Desktop | Mobile | Migrate? |
|---|---|---|
| List, folders, filter, pin | Yes: folder rows, filter bar, pin | done |
| Editor, formatting toolbar, images | Yes: `NoteEditorBody`, `NoteEditorToolbar`, insert image | done |
| Markdown preview, code, math, Mermaid, table of contents | Yes: `MarkdownView`, `CodeBlock`, `MathView`, `MermaidView`, "On this page" | done |
| Wikilinks and picker | Yes | done |
| Tags | Yes: Edit tags | done |
| Rename, move to folder, move to project, archive, delete | Yes | done |
| Export Markdown, PDF | Yes | done |
| Inline AI actions | Yes: AI actions in the editor | done |
| Backlinks panel | Unchecked: no backlinks section found on the note screen | Medium, S: the link data syncs (`linked_note_ids`, wikilinks) |
| Find in note | No | Low |
| Archived notes list | Unchecked | Low |
| Generate PRD (`PrdModal`), spawn tasks from a note | No; `spawn_tasks_from_note` is not a mobile tool | Low |
| Meeting strip and attendees on a note | Yes: Add attendees | done |

## Board and tasks

| Desktop | Mobile | Migrate? |
|---|---|---|
| Board, drag between columns | Yes: `DraggableBoard`, edge auto-scroll | done |
| Card detail: title, description, priority, due date, assignee, column, tags | Yes | done |
| Archive, delete | Yes | done |
| Linked notes on a card | Partial: links are stored and used by chat tools; no link editor on the card screen confirmed | Medium, S |
| Blocked by (dependencies) | No on the card screen; `update_tasks` can set it from chat | Low, S |
| Filters (search, assignee, due today, due within 7 days) | Partial: project filter bar; desktop filter set not matched row for row | Low |
| Add, rename, delete column; WIP limit | **No**: nothing writes `board_columns` | Medium, S |
| Archived tasks view with search | Unchecked | Low |
| Agent badge, work log (`task_progress`) | No | Low: a coding-agent job. Drop `task_progress` from the mobile tool list rather than add it |

## Calendar

| Desktop | Mobile | Migrate? |
|---|---|---|
| Month grid, project and all-projects | Yes | done |
| Week grid | Partial: `CalendarView` has week logic; not compared with desktop's `WeekGrid` | Low |
| Drag to reschedule | Yes | done |
| Unscheduled tray | Yes | done |
| Overdue tray | Unchecked | Low |
| Day detail | Yes: `CalendarDayPanel` | done |
| Meetings on the calendar | No on either side (desktop calendar shows tasks only) | Not parity; a candidate if Today needs a day strip |

## Today

Desktop: `TodayView` over the brief that the Today automation writes. Mobile: the Workspace tool at `/workspace/today` over `shared/today/local.ts`.

| Desktop | Mobile | Migrate? |
|---|---|---|
| Overdue and due-today tasks | Yes | done |
| Today's meetings | Yes (list) | done |
| People due to meet (rhythm) | Yes | done |
| Live line, pin, widget link | Yes: Workspace row, pinnable accessory | done |
| `get_today` chat tool | Yes: local digest | done |
| Day strip with free time (`dayBlocks`) | No | **Yes, S**: `dayBlocks` is already pure in `shared/today/` and meetings are on the phone |
| Open action items (you owe / they owe) | No on Today; the person page has them (`loadOpenItems`) | **Yes, S**: a "You owe" section across people |
| Your projects facts (`today-facts.ts`) | No | Medium, M: port the queries to mobile, keep the shaping in `shared/today/` |
| Headline, stat tiles | No | Low, S once the facts exist |
| AI lanes: Need you, Prepared for you, Moving without you | No | **L**: needs the brief published (see "What syncs"). Recommended transport: a synced `today_briefs` row per workspace and day |
| Marks (done, edited drafts), history | No | L, after the brief syncs; marks from the phone push the transport toward a row |
| Act panel, nudges | No | L, with the brief |

Next steps, in order: day strip and open items (S, phone only), then project facts (M), then the brief row (L, desktop + sync).

## People

### Views (desktop 8 modes, mobile 4)

| Desktop mode | Mobile | Migrate? |
|---|---|---|
| List (grouping, filter, search) | Yes: five groupings, search. No "Everyone / only this group" filter | Low, S |
| Teams | Yes: nested list, team page | done |
| Map (map and globe, time slider) | Yes | done |
| Time zones | Yes: Zones segment | done |
| Rhythm | Yes: overdue / due soon / on track list | done |
| Org chart (reporting line) | Partial: Teams is the team tree; `manager_of` edges are not drawn | Medium, M: `src/lib/people/network.ts` imports only shared types, so it moves to `shared/people/` as is; `layout.ts` needs d3-hierarchy, which can run on the phone |
| Relationships (`ConnectionsGraph`) | No | Low: the person page lists them |
| Bridges | No | Low, S after `network.ts` moves (`bridges.ts` depends only on it) |
| Find people in notes (`MigrationPanel`) | No | Low: desktop job |

### Editing

| Desktop | Mobile | Migrate? |
|---|---|---|
| Add a person | **No** | **Yes, high, S**: `createPerson` is already in `shared/people/queries.ts`; a New person sheet in People |
| Delete a person | **No** | **Yes, S**: desktop's `deletePerson`; add the shared query if it lives in the store only |
| Confirm, dismiss, add back a suggested person | Yes | done |
| Merge ("same person as") | Yes | done |
| Profile: role, team, location, time zone, Slack id | Yes: `saveProfile` | done |
| Name and aliases | Partial: aliases shown, not edited (unchecked) | **Yes, S** |
| Emails | Unchecked | S |
| Place picker with zone lookup (`PlaceInput`) | No: free text location | Medium, S: `place-zone.ts` and `zone-coords.ts` are shared |
| Avatar | Unchecked | Low |
| Relationships and cadence | Yes: Relationship sheet | done |
| Manager / reports to | Partial: through the relationship sheet only; no org chart to check it in | With Org chart |
| Teams: create, rename, merge, delete, add, move, leave | Yes | done |
| Persona note | Yes: opens the note | done |
| Autofill profile (AI, Slack) (`PersonaAutofill`, `BatchAutofill`) | No | Low, M: needs a chat provider call; `autofill.ts` and `parseSlackProfile` are shared |
| Open items: tick done | Yes | done |
| Note attendees: add, confirm, remove | Yes | done |
| One-on-one view (`PersonOneOnOne`) | No | Medium, S: `shared/people/oneonone.ts` holds the logic (nudges, prep brief parsing) |

Recommended People batch: Add person, Delete person, name and aliases edit, then the one-on-one view. All S over shared code.

## Knowledge graph

Desktop: `KnowledgeGraphView` with Force, Radial and 3D (`Graph3DCanvas`, three.js). Mobile: Skia `KnowledgeGraphSkia` (`mobile/src/graph`).

| Desktop | Mobile | Migrate? |
|---|---|---|
| Force layout | Yes | done |
| Radial layout | Yes | done |
| 3D layout (rotatable) | **No** | **Maybe, M–L**: no 3D renderer in the app today (Skia is 2D). Options: (a) a 3D projection drawn in Skia (rotate the force positions with a camera matrix and draw by depth; no new native module), (b) three.js in the existing graph WebView (`KnowledgeGraphWebView`), reusing desktop's scene code, (c) `expo-gl` + three. Recommend (a) first as a spike: it keeps one renderer, gestures already exist (`useGraphControls`), and a phone has the gyroscope for tilt |
| Label modes (smart, all, minimal) | Yes | done |
| Cluster hulls | Yes | done |
| Search, node type toggles | Yes: `filterGraph` | done |
| Edge legend | Unchecked | S |
| Semantic edges with threshold | Partial: on/off toggle with on-device embeddings; no threshold slider | Low, S |
| Co-mention edges | No | Medium, M: note mentions sync |
| People and meeting nodes (Attended, Mentions edges) | **No**: the mobile graph builds projects, notes, tasks and tags only | **Yes, M**: people, meetings, attendees and mentions all sync; add them to `getKnowledgeGraph` and colours to `mobile/src/graph/colors.ts` |
| Neighbourhood focus (1–3 hops, Esc to exit) | No | **Yes, S**: desktop's `neighbourhood.ts` is pure; move it to `shared/` |
| Project scope picker | No | Low, S |
| Idea-flow edges | No | L: idea flows do not sync |
| `get_graph` chat tool | No | Low, S once the graph builder is shared |

Recommended graph batch: people and meeting nodes, neighbourhood focus, then the 3D spike.

## Search

| Desktop | Mobile | Migrate? |
|---|---|---|
| Search notes and tasks | Yes: own tab | done |
| Semantic search | Yes: Apple on-device embeddings | done |
| Search people, tags | Unchecked | Low |

## Chat and assistant

| Desktop | Mobile | Migrate? |
|---|---|---|
| Streaming chat, tools | Yes | done |
| Approval before a delete | **Yes**: the `delete` tool waits on a Delete / Cancel card in the chat (`confirm-store`); Cancel tells the model to leave it | Done. People `archive` / `team_delete` still run without a card |
| Expandable tool cards showing what changed | Yes (PR 334) | done |
| Provider, model, temperature, max steps | Yes: model chip panel | done |
| Personalities, chat themes | Yes | done |
| Several threads, thread list | **No**: one conversation per phone, Clear only | Medium, M: `chat_local` gets a thread id; device-local like desktop |
| Archive chat as a note (`/archive-chat`) | No | Medium, S: `createNote` exists |
| Compact history (`/compact`) | No | Low |
| Slash commands, `/` picker | No | Medium: built-ins S (move `BUILTIN_CHAT_COMMANDS` to `shared/`), your own commands L (device-local table) |
| Writing style | Yes, read-only page (PR 336) plus the tools | Edit: Low |
| `ask_questions` (question cards) | Yes: a form card at the end of the transcript (`QuestionCard`, `questions-store.ts`); answers go back as the tool result, Skip settles it | done |
| `suggest_connections` | No | Low |
| Mentions (`@` people, notes) | Yes: `mentions.ts` | done |
| Attachments | Yes, plus camera, photos | done |
| Subagents, goals, jobs, terminals, LSP | n/a | no |

Tools: mobile has 16 of 24 desktop tools (`people` counted once): `get_context`, `get_item`, `search_notes`, `search_tasks`, `ensure_note`, `edit_note`, `update_notes`, `create_task`, `update_tasks`, `upsert_project`, `delete`, `people`, `ask_questions`, `get_user_writing_style`, `update_user_writing_style`, `get_today`.

| Missing tool | Decision |
|---|---|
| `get_graph` | Add with the shared graph builder |
| `task_progress` | Skip: agent work log, a coding-agent job |
| `suggest_connections`, `spawn_tasks_from_note` | Low |
| `get_idea_flow`, `edit_idea_flow` | L: idea flows do not sync |
| `codebase_query`, `codebase_reindex` | n/a |

## Idea Flow, Insights, Automations, Usage, Agent

| Desktop view | Mobile | Migrate? |
|---|---|---|
| Idea Flow | No | L: sync idea flows first; then read-only pan and zoom |
| Insights (8 canvases) | No | Low, M: they read graph and task data that already syncs; one or two that read well on a phone |
| Automations | No | L: device-local tables; a read-only runs list and notification feed would need them synced |
| Usage | Yes: Workspace tool | done |
| Agent (coding) | n/a | no |

## Settings

Mobile: one Settings modal (`/settings`) with the four desktop group names.

| Desktop page | Mobile | Migrate? |
|---|---|---|
| General: theme, accent, font size, note font | Partial: accent and note font; theme and text size follow the system | Low |
| General: workspace name, folder | Unchecked: switcher exists, rename not found | Low, S |
| Sidebar & views | No | Low: mobile tabs are fixed |
| Tags | Yes: rename, recolour, delete (PR 336) | done |
| Shortcuts | n/a | no |
| Models / Chat | Yes. Missing: context window and output limits are per provider only, no inline AI settings or prompt preview | done |
| Coding agent | n/a | no |
| Writing style | Partial: read-only page (PR 336) | Low: edit |
| Embeddings | Partial: `EmbeddingsCard`, on-device | done for the phone's job |
| Tools (MCP, HTTP services) | Yes | done |
| Commands | No | With slash commands |
| Connect other agents | n/a | no |
| Device sync | Yes | done |
| Data | Partial: storage and counts (PR 336). Reset only from the database-error screen; no export | Medium, S: Reset with confirm; export as a zip of Markdown |
| About | Partial: version only | Low: what's new could read `src/generated/new-features.json` filtered to mobile |

## Cross-cutting

| Desktop | Mobile |
|---|---|
| Workspace switcher | Yes, Workspace tab and Projects menu |
| Command palette, global shortcuts | n/a (Search tab, quick actions) |
| Capture | Mobile-first; share extension planned (`mobile-capture-and-widgets.md`, section E) |
| Sync | Shared engine; phone can delete a workspace from the sync folder |
| Onboarding, tour | Partial: `OnboardingGuide` on mobile; not compared with the desktop tour |

## Mobile only

Checked against `mobile/src`, `mobile/modules` and `app.json`, 2026-11-22.

| Mobile feature | What it is | Desktop |
|---|---|---|
| AI capture | Capture sheet files a thought, to-do or link into the right project, with confirm card and Undo | No equivalent |
| Voice dictation | Hold-to-talk mic in chat and capture, on-device | No |
| Home-screen widgets | Workspace progress, due today, Capture, per-project progress | No |
| Quick actions | Quick capture, Search | n/a |
| On-device AI | Apple Intelligence chat provider, Apple embeddings | Own embedding model |
| Background sync | Periodic catch-up while closed | Syncs while open |
| Camera, photos in chat | `+` panel | Files only |
| Fold and tablet layouts | iPhone Duo postures, iPad split view | n/a |
| Touch drag and drop | Board and calendar | Mouse drag |
| Stones and milestones | Skia cairn with celebrations and haptics | No |
| Haptics | Across the app | n/a |

Planned, not built: share extension, lock-screen capture control, a "stone to revisit" daily pick (`mobile-capture-and-widgets.md`, sections D and E).

## Suggested order

Small and phone-only first, then the sync changes.

1. **Projects**: create and edit, `upsert_project`. Done (2026-11-22); archive and delete project remain.
2. **People editing**: Add person, Delete person, name and aliases, then the one-on-one view (S each, over `shared/people`).
3. **Today, phone only**: day strip, open items, then project facts (S, S, M).
4. **Knowledge graph**: people and meeting nodes, neighbourhood focus, then a 3D spike in Skia (M, S, M–L).
5. **Board**: column add, rename, delete; linked notes on the card (S).
6. **Chat**: threads, archive as a note, built-in `/` commands (M, S, S). `ask_questions` done 2026-11-22. Desktop threads are now named by the chat model after the first reply (`shared/chat/title.ts`), which mobile threads can reuse.
7. **People views**: Org chart after moving `network.ts` to `shared/` (M), Bridges after it (S).
8. **Settings**: Data reset and export, workspace rename, What's new (S each).
9. **Sync changes** (L, each needs a desktop PR): Today brief row, then idea flows, then automations and notifications.

Not planned: Agent, Automations editing, shortcuts, coding-agent settings, `task_progress` on mobile.

Rows marked **Unchecked** need a look at the running app before they are planned.
