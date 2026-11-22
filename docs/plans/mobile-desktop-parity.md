# Mobile vs desktop parity matrix

Status: audit, 2026-11-21; re-checked against the code 2026-11-22 (unchecked rows resolved, settings and chat rows updated for PR 335). Source: the desktop view list (`scripts/export-site-data.js`), `settings-index.ts`, `PeopleView.tsx`, `TOOL_SCHEMAS`, and the mobile `app/` routes, `src/screens`, `src/chat/tools.ts`.
Legend: **Yes** = same job done; **Partial** = some of it; **No** = not on mobile; **n/a** = does not belong on a phone. Rows were judged from the code and the desktop inventories, not from running the app; the 2026-11-22 pass resolved every row that was marked unchecked.

## Views

| Desktop view | Mobile | Notes | Migrate? |
|---|---|---|---|
| Overview | Yes | Overview tab inside a project, plus the workspace progress card on Projects | done |
| Notes | Yes | Per-project note list, editor, wikilinks, tags | done |
| Board | Yes | Draggable board in a project | done |
| Calendar | Yes | Project and all-projects calendar | done |
| Idea Flow | No | No screen or route | Maybe: read-only first (pan and zoom), editing is a poor fit for touch |
| Agent (coding) | n/a | Needs files, terminals, git | no |
| People | Partial | List, Teams, Map; see below | see People |
| Knowledge Graph | Yes | Skia force and radial | done |
| Insights (8 canvases) | No | | Low: one or two that read well on a phone (for example the bullet or ridgeline chart) |
| Automations | No | Run in the desktop app | Maybe: a read-only list of runs plus the notification feed |
| Usage | Yes | Workspace tab (a tool, with the tab bar) | done |
| Today | **No** | Still no screen, route or tab; `get_today` is also missing on mobile (confirmed 2026-11-22). Desktop has it as a view; the desktop sidebar lists it above Automations | **Yes, high**: the biggest gap. Note: the desktop *brief* is a file under the automation output folder and does not sync; the tasks, meetings and people it draws on do. See `docs/plans/mobile-today.md`. Decided 2026-11-22: a Workspace tool (`/workspace/today`), pinnable to the accessory; build a local Today from synced data first, the synced brief second |
| Search | Yes | Own tab | done |
| Chat | Partial | See Chat. The model chip panel now covers provider, model, temperature and max steps in the chat box | see Chat |

## People (desktop has 8 modes, mobile 3)

| Desktop mode | Mobile | Migrate? |
|---|---|---|
| List (grouping, filter, search) | Yes: five groupings, search. No "Everyone / only this group" filter | Low: add the filter |
| Teams | Yes: nested list, team page, edit | done |
| Map (map and globe, time slider) | Yes | done |
| Time zones | Yes: Zones segment, grouped working / early or late / asleep, with shared hours | done |
| Org chart | Partial: the Teams list is the nested team tree. The reporting line of people (`manager_of` edges) is not shown; `src/lib/people/network.ts` has to move to `shared/` and the edge query to the phone first | Medium |
| Relationships | No | Low: dense graph; the person page already lists relationships |
| Rhythm (cadence over time) | Yes: Rhythm segment as an overdue / due soon / on track list | done |
| Bridges (people who connect teams) | No | Low |
| Find people in notes (migration panel) | No | Low: desktop job |
| Add person | No: no add button (confirmed); people appear from notes or the assistant | Medium |
| Person page: profile, one-on-one, open items, timeline | Partial: profile, open items, timeline, teams, relationships. No one-on-one view (confirmed) | Low |

## Chat and assistant

| Desktop | Mobile | Migrate? |
|---|---|---|
| Streaming chat, tools, approvals for deletes | Yes | done |
| Tools (24 on desktop) | 13 of 24 (diffed against `TOOL_SCHEMAS`, 2026-11-22; `people` counts as one) | See tool gaps |
| Slash commands (Settings → Commands) | No: no command list or `/` picker on mobile (confirmed) | Medium: the chat box is now the main surface, so a `/` picker would fit |
| Personalities, chat themes | Yes: personality in the `+` panel and AI settings, chat theme in AI settings | done |
| Writing style | Partial: the `get/update_user_writing_style` tools work and Sync shows the style's status; no screen to view or edit it | Medium: a read-only page first |
| Model providers, keys | Yes: Provider & model, Providers | done |
| Subagents, goals, jobs, terminals, LSP | n/a | no |

Tool gaps (desktop tool, absent on mobile): `get_today`, `task_progress`, `upsert_project`, `get_idea_flow`, `edit_idea_flow`, `get_graph`, `codebase_query`, `codebase_reindex`, `ask_questions`, `suggest_connections`, `spawn_tasks_from_note`. Codebase tools are n/a. `get_today`, `task_progress` and `upsert_project` are worth adding; `get_graph` follows if the phone gets a graph summary.

## Settings (desktop groups: App, AI, Extensions, Data)

Mobile: one Settings modal (`/settings`) with the same four group names; the hub lists Appearance, AI settings, Tools and services and Sync.

| Desktop page | Mobile | Migrate? |
|---|---|---|
| General (theme, accent, font size, note font) | Partial: Appearance has accent colour and note font. Theme follows the system and text size follows the OS setting, with no in-app control | Low |
| Sidebar & views | No | Low: mobile tabs are fixed; useful only if Today or Automations arrive |
| Tags (rename, recolour, delete) | No | Medium: tag management |
| Shortcuts | n/a | no |
| Models / Chat | Yes: AI settings hub (tuning, personality, renderer, chat theme), Provider & model, Providers. Missing vs desktop: context window and output-token limits are per provider only, no inline AI or prompt preview | done |
| Coding agent | n/a | no |
| Writing style | Partial: status line in Sync only; no screen | Medium |
| Embeddings | No | Low |
| Tools (MCP, HTTP services) | Yes: Tools and services | done |
| Commands | No (confirmed) | Medium, with slash commands |
| Connect other agents | n/a | no |
| Device sync | Yes: Sync | done |
| Data (storage, export, reset) | No | Medium: at least storage and reset |
| About (version, tour, what's new) | Partial: the version shows at the bottom of Appearance; no tour or what's new | Low |

## Cross-cutting

| Desktop | Mobile |
|---|---|
| Workspace switcher | Yes, at the top of the Workspace tab and in the Projects menu |
| Command palette, global shortcuts | n/a (Search tab, quick actions) |
| Capture | Mobile-first: capture sheet, widgets, quick actions. A share extension is planned, not built (`mobile-capture-and-widgets.md`, section E) |
| Sync | Shared engine; phone can delete a workspace from the sync folder |

## Mobile only (the phone is ahead, or the job does not exist on desktop)

Checked against `mobile/src`, `mobile/modules` and `app.json`, 2026-11-22.

| Mobile feature | What it is | Desktop |
|---|---|---|
| AI capture | The capture sheet files a thought, to-do or link into the right project (ranked, with confirm card and Undo). Entry points: Projects toolbar, home-screen quick action, `cairn://capture` | No equivalent; desktop has the editor and chat |
| Voice dictation | Hold-to-talk mic in the chat box and capture, on-device where supported, project and note titles as vocabulary | No |
| Home-screen widgets | Workspace progress and what is due today, one-tap Capture, per-project progress | No |
| Quick actions | Long-press the app icon: Quick capture, Search | n/a |
| On-device AI | Apple Intelligence as a chat provider (on-device and Private Cloud Compute) and Apple on-device embeddings for semantic search, so search works with no desktop | Desktop embeds with its own model |
| Background sync | A periodic catch-up while the app is closed, over the iCloud sync folder | Desktop syncs while open |
| Camera, photos, files in chat | Recent photos strip, Camera, Photos and Add files from the `+` panel | Files only |
| Fold and tablet layouts | iPhone Duo postures (side rail, crease-aware split), iPad split view and sidebar-adaptable tabs | n/a |
| Touch drag and drop | Board cards, with edge auto-scroll | Mouse drag |
| Stones and milestones | A Skia cairn that stacks as notes are written, with milestone celebrations and haptics | No |
| Haptics | Selection, success and settle feedback across the app | n/a |

Planned, not built: share extension and a lock-screen capture control (`mobile-capture-and-widgets.md`, section E); a "stone to revisit" daily pick (section D).

## Suggested order

1. Today screen and the `get_today` tool: biggest gap, best fit for a phone. Planned in `docs/plans/mobile-today.md` (Workspace tool, local first).
2. People: a reporting-line Org chart (needs `network.ts` moved to `shared/`).
3. Settings: Tags, Data (storage and reset), Writing style page, Commands and a `/` picker in Chat, About.
4. Tools: `task_progress`, `upsert_project`.
5. Read-only Idea Flow and one or two Insights charts, if there is demand.

Not planned: Agent, Automations editing, shortcuts, coding-agent settings.
