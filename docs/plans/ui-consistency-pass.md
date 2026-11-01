# UI consistency pass: inventory and plan

Branch: `design/ui-consistency-pass` · Audited 2026-11-01 against v3.1.7

## How this was audited

- `npm run screenshots:audit` (new: `playwright.audit.config.ts` + `tests/e2e/design-audit.spec.ts`) renders the app with the mocked-IPC marketing fixture and captures the surfaces in light and dark into `design-audit/screens/<theme>/` (git-ignored). That covers every view, every Settings section and subtab, the chat drawer, the session switcher, search, notifications, the collapsed rail, the main modals (task detail, card menu, PRD generator, New menu, tool builder, community catalogs), onboarding, and a 900px-wide window. `ONLY=14,20 THEME=dark npm run screenshots:audit` re-shoots a subset. Re-run it after each phase to get before/after images.
- Code sweep of `src/components` for drift from the primitives in `src/components/ui/` and the tokens in `src/app/globals.css`.
- Not covered yet: the What's New modal and the real Electron title bar (`npm run screenshots:electron` covers the latter).

## What "the system" is today

Fit is judged against what the app already does well, so the canon comes from the best existing surfaces:

| Layer | Canon (keep) | Where it's done right |
|---|---|---|
| Colour | `var(--token)` everywhere, `color-mix` for alpha; sage accent (`--accent`, `--accent-dim`) for selection | Board, sidebar nav, Settings General |
| Menus | Radix `DropdownMenu` (portal, `sideOffset 6`, `shadow-lg`, `rounded-lg`, `py-1`, `text-xs` items, `--surface-2` highlight) | `ui/dropdown.tsx`, `ui/select.tsx`, DockSidebar project menu |
| Settings rows | `SettingsGroup` + `SettingsRow` (title, description, control right-aligned) | Settings General, System → Data |
| Segmented choice | `SegmentedControl` / `Tabs` pill group | Theme, Font size, Note font |
| Buttons | `ui/button.tsx` variants `default · ghost · outline · danger · accent`, sizes `xs–lg, icon` | Automations header, Flow toolbar |
| Empty state | `ui/empty-state.tsx`: icon tile, title, one line of direction | Agent editor, Notifications, Search |

## Fit matrix

Legend: **Fits** means it is on-system. **Drifts** means it is mostly on-system with visible inconsistencies. **Off** means it is hand-rolled or reads as a different product.

### Shell and navigation

| Surface | Fit | What fits | What doesn't | Sev |
|---|---|---|---|---|
| Top bar | Drifts | Search pill, accent "New" button | Unlabelled `active` / `high` pills next to the breadcrumb (project status and priority, but nothing says so). The "Chat" toggle, a sliders icon and the bell are three different button treatments. | M |
| Dock sidebar (expanded) | Drifts | Accent-dim selection, grouped sections | **Shortcut labels are wrong:** Overview shows ⌘3 and Board ⌘5, because `DockSidebar` passes Overview and Notes into `buildShortcutMap`, which already starts at 3 (the real keys are ⌘1 and ⌘3). Two **Calendar** entries: Views → Calendar and Workspace → Calendar "all". **Notifications** is in the sidebar and on the bell. The project card and the Project picker show the same name twice, stacked. The six nav buttons are copy-pasted class strings (`DockSidebar.tsx:439-444`), so they drift independently of the rail (`:233-238`). | H |
| Dock sidebar (collapsed rail) | Fits | Consistent icon buttons, tooltips | Two calendar icons with no label difference | L |
| Conversations (sidebar) | Drifts | Search input and row styling match the nav | Duplicates the drawer's session switcher with different row styling. Shows one thread when the fixture has two (the other project's thread is hidden, with no hint that it exists). | M |

### Views

| Surface | Fit | What fits | What doesn't | Sev |
|---|---|---|---|---|
| Overview | Drifts | Strong identity: display serif italic tagline, progress ring, task-flow bars | Most crowded type: ALL-CAPS eyebrows on every block ("NEEDS ATTENTION", "PROGRESS · NEEDS ATTENTION", "FOCUS"), mono "Showing all · 2 items", tile priority cards with uppercase labels. The accent button "Insights →" is the only arrow CTA in the app. (The floating composer covering content mid-scroll is intended: it clears the last row once scrolled to the bottom.) | M |
| Notes | Fits | List, tag chips and editor toolbar all tokenised | The AI action bar (Rephrase / Summarize / …) is greyed out and reads as disabled rather than contextual. "Edit / Read / Live Preview" mixes a segmented group with a separate outlined accent button. | L |
| Board | Fits | Columns, cards, chips and filters are the reference surface | Priority filter chips (Low/Medium/High/Urgent) look disabled at rest | L |
| Calendar | Drifts | Grid and Today control | The overdue tray (25 red chips) takes 20% of the view above the calendar. Mono "was Aug 25, 2026" meta. Uppercase weekday headers. | M |
| Idea Flow | Drifts | Canvas controls, Arrange / Add node | "Linked note not found" is red italic inline: an error styling that appears nowhere else. Square accent handles differ from the round ports in the graph. | L |
| Knowledge Graph | Fits | Canvas-only; on-system controls | — | — |
| Insights | Off | Canvases themselves | **Seven of the eight canvas tabs are icon-only** with no visible label, so they're undiscoverable. A second segmented control (`ridge / flat / 3d`) is lowercase mono and styled differently from the first. A bare slider has no label. | H |
| Agent | Drifts | File tree, editor tabs, empty states | Three empty panes on open ("Directory is empty", "Select a file to edit", "Open a file to see its structure"). The terminal is hard black in light theme. "CAIRN-DEMO" and "ARCHITECTURE" use a third uppercase-label style. | M |
| Automations | Drifts | Card list, accent CTA, toggles | Raw cron strings (`0 8 * * 1-5`) as the schedule. Four icon-only actions per row with no labels. A "disabled" badge appears alongside the off toggle (it says the same thing twice). The header uses the "Title — fragment" pattern while Usage uses title + description. | M |
| Usage | Drifts | Stat tiles, segmented range | Three empty states with three voices ("No usage in this range yet." / "No usage yet." / "No LLM calls recorded yet" + subtitle). Icon-only delete and refresh. Uppercase tile labels and legend. | L |

### Chat

| Surface | Fit | What fits | What doesn't | Sev |
|---|---|---|---|---|
| Chat drawer | Drifts | Bubbles, tool-call chips, composer | Header row has three button shapes side by side (round "+", square "⋯", square "›"). A second header row (project name + 3 icons) repeats context. The composer footer packs four pickers plus a hint line. | M |
| **Session switcher** (drawer and chat view header, `agent/SessionBrowser.tsx`) | **Off** | Keyboard listbox semantics, search | Hand-rolled `absolute` popover instead of the Radix menu, so there's no portal. It's wider than its trigger and spills over the header actions. When open, the trigger gets an accent border that no other select uses. The two-line trigger carries a 0.607rem meta line ("Chat · 1 session"). Uppercase "ALL SESSIONS" label. The selected row has a left accent stripe and stops short of the list edge (space reserved for the hover-only delete). In the centred chat view it reads **"Sessions / Choose a session"** while a conversation is open. | **H** |
| Chat view (centred) | Drifts | Centred transcript, composer | Same switcher issues. The header is mostly empty space with actions on the far edge. | M |
| Dead code: `agent/AIChatTab.tsx` | — | — | Unused thread dropdown (a `span role=button` nested inside a `button`). Delete it. | L |

### Settings

| Surface | Fit | What fits | What doesn't | Sev |
|---|---|---|---|---|
| Settings shell | Off (navigation) | Row primitives are clean | **Three stacked navigations:** the app sidebar (project context irrelevant here), the settings rail, then subtabs. Every page opens with a large "Cairn v3.1.7" identity header that pushes content down. Content is a `max-w-2xl` column centred in about 1000px with empty space either side. No settings search. Long pages have no in-page anchors. | **H** |
| General | Fits | Reference page | "Views" visibility lives here, but AI → Chat says "view visibility is managed in General", so the cross-reference is a sign of wrong grouping | L |
| AI → Chat / Coding Agents | Off (IA) | Rows, steppers | **The same blocks appear twice** (Community providers, Saved providers, Max steps, Temperature, Context window, Max output). Users can't tell which applies where. Chip steppers sit under an input that holds the same value. Descriptions run to four lines. | **H** |
| AI → MCP vs Extensions → Tools → MCP Servers | Off (IA) | — | **"MCP" means opposite things in two places:** AI → MCP is *Cairn as a server for other agents*, while Extensions → MCP Servers is *servers Cairn's AI uses*. Status line "SQLite — 1W · 3P · 38N · 65C" is cryptic. | **H** |
| Extensions → Tools | Drifts | Feature cards | Uppercase "CONFIGURED SERVERS" labels, centred empty states inside a left-aligned page | L |
| Embeddings / Writing Style | Drifts | — | Captured; same shell issues | L |
| Device Sync | Drifts | — | A paragraph-long description plus a callout repeating it. **Copy bug:** "installedfor" (missing JSX space, `SyncSettings.tsx:149`). "Pick the SAME folder" uses shouting caps. | M |
| System → Shortcuts / Data / About | Fits | Data stat tiles, row actions | Tags settings exist (`TagsSettings`) but aren't in the nav; they're only reachable by legacy deep link | M |
| **AI settings crash** | **Bug** | — | **Opening Settings → AI with no saved providers crashed the app** ("Maximum update depth exceeded"): the `?? []` selector in `LocalServersCard`. **Fixed on this branch.** | **H** |

### Overlays

| Surface | Fit | What fits | What doesn't | Sev |
|---|---|---|---|---|
| Search (⌘K) | Drifts | Filter chips, empty state | The active "All" chip is solid black in light theme instead of accent. Keyboard hints appear twice (empty state and footer). "0 results" and "0 hits" are both shown. Mono labels. | M |
| Notifications popover | Fits | Header, empty state, footer | "Close" text button duplicates click-outside; small | L |
| Hand-rolled popovers (13 files) | Off | — | `TagsSettings`, `note-export-menu`, `BacklinksPanel`, `sync-status-indicator`, `KnowledgeGraphView`, `flow-view`, `ChatInput`, `chat-panel` (popout project menu), `SessionPane`, `SessionBrowser`, `DependencyMatrix`, `AgentSessionTab`, `AIChatTab`. Each picks its own shadow (`shadow-lg`/`xl`), offset (`mt-0.5`/`mt-1`) and width. | H |

### Modals, menus and onboarding (shots 40–64)

| Surface | Fit | What fits | What doesn't | Sev |
|---|---|---|---|---|
| Task detail | Drifts | Modal shell, title field, sidebar layout | Five uppercase labels ("DESCRIPTION", "PRIORITY", "COLUMN"…), each with a different icon or none. Priority options are lowercase while the rest of the app uses sentence case. Every workspace tag (28 in the fixture) is shown inline, so the applied ones are hard to spot. "Spawn Agent" is the only accent-coloured action in the list. | M |
| PRD generator | Fits | Uses the modal shell and composer | The empty body is a centred paragraph rather than `EmptyState` | L |
| Tool builder / community catalogs | Fits | `catalog-browser-shell` is shared | — | — |
| Onboarding (folder step) | Drifts | Serif wordmark, clear single action | The card floats mid-screen with a large gap under the wordmark. Its accent button is lighter than the app's accent "New" button. | L |
| 900px window | Fits | Chat correctly falls back to the centred view; the top bar collapses its search | The sidebar keeps its full 244px, so content gets about 650px. Candidates for auto-collapsing below about 1000px. | L |

## Cross-cutting findings (from the code sweep)

| Finding | Evidence | Why it matters |
|---|---|---|
| No type scale | 14 distinct `text-[N rem]` sizes; the top four are `0.714` (456 uses), `0.643` (196), `0.65` (105) and `0.786` (96). `0.65` and `0.643` are visually identical. Five sizes sit below 9px at scale 1 (`0.607`, `0.6`, `0.571`, `0.5625`). | It's the main reason the app feels "almost consistent". There's nothing to snap to. |
| No elevation scale | `shadow-sm` 31, `shadow-xl` 13, `shadow-lg` 15, `shadow-2xl` 10, `shadow-md` 7 | Menus, popovers and modals don't read as layers of one stack |
| Radius by habit, not hierarchy | `rounded` 325, `rounded-md` 254, `rounded-lg` 188, `rounded-full` 156, `rounded-xl` 60 | Round "+" next to square "⋯" in the chat header |
| Uppercase tracked labels | 100 `uppercase tracking-*` | Four different eyebrow styles (sidebar, overview tiles, settings, agent pane headers) |
| Tooltip split | 258 native `title=` vs 163 `<Tooltip>` | Icon-only buttons get an OS tooltip after a delay, or nothing on touch |
| Raw buttons | 544 `<button>` vs 194 `<Button>` | Hover, focus and disabled states drift; most icon buttons have no visible focus ring |
| Monospace for meta | 246 `font-mono` | Fine for code, counts and kbd. Overused for dates and status strings. |
| Clean | 0 `text-[Npx]`, 1 raw Tailwind colour, 3 `rgba(` (canvas-only) | Token discipline is good. This pass is about structure, not colour. |

## Plan

Ordered so each phase is shippable on its own and the later phases get cheaper. Each phase is a branch cut from the previous phase's branch, with its PR based on that branch, so they merge in order (Phase 0 is ddutchie/cairn#268). Every phase ends with `npm run screenshots:audit` and a changelog line in `changelogs/v3.1.8.md` (or whatever is next above `package.json`).

### Phase 0: Bugs and harness (small, ship first)

1. ✅ Fix the Settings → AI crash (`AISettings.tsx` stable empty array).
2. ✅ Fix the sidebar shortcut labels. `NUMBERED_VIEWS` and `buildViewShortcutMap` in `sidebar-utils.ts` are now shared by the `page.tsx` key handler and the sidebar, so the two can't drift again.
3. ✅ Fix the "installedfor" copy (`SyncSettings.tsx:149`) and the "SAME folder" caps.
4. ✅ Make the chat view's switcher show the open thread instead of "Choose a session". The centred chat view now counts as a visible chat surface in `SessionBrowser`.
5. ✅ Delete `agent/AIChatTab.tsx` (unused).
6. ✅ Extend the audit spec: onboarding, task detail, card context menu, PRD generator, New menu, tool builder, both community catalogs, and a 900px-wide window (shots 40–64). Also give the Notes "Generate PRD" icon button an `aria-label`.

### Phase 1: Foundations (tokens and primitives, no visual redesign) ✅

Branch `design/ui-pass-phase-1`, stacked on Phase 0. Compare with `npm run screenshots:compare` (see "Before/after review" below).

1. ✅ **Type scale.** `text-2xs` (9px, new token) · `text-xs` (10.5px) · `text-sm` (12.25px) · `text-base` (14px), a ~1.17 step at scale 1. A codemod moved 941 arbitrary sizes in 190 files onto it: 0.5–0.65rem to `2xs`, 0.688–0.75rem to `xs`, 0.786–0.929rem to `sm`, and the 0.938rem search input to `base`. Arbitrary sizes remain only for data-density cases (timeline bars, matrix cells that shrink with item count) and display numerals. *Changed from the draft:* `text-xs` stays Tailwind's 0.75rem rather than being redefined as 0.714rem, so the 484 existing `text-xs` uses don't move. 10px text becomes 10.5px and 11px becomes 12.25px, which keeps the old title/meta hierarchy and lifts it slightly.
2. ✅ **Elevation.** `--elev-1/2/3`, themed per light/dark (dark needs denser shadows), exposed as `shadow-elev-1/2/3`. All 65 Tailwind shadow uses and the four one-off arbitrary shadows are mapped by role: menus, popovers and tooltips are 2; modals, search and dragged columns are 3. The raw `shadow-black/N` colours are gone.
3. ◐ **Radius by hierarchy.** Rule recorded in AGENTS.md. The only off-pattern icon button (the round chat header "+") is fixed via `IconButton`. No blanket codemod: the remaining `rounded-full` uses are pills, avatars, dots and toggles, which the rule allows.
4. ✅ **One label style.** 115 uppercase label strings in 64 files are now sentence case with tracking removed. Bare 9px labels go up to `text-xs` so they keep their weight without caps. `font-semibold` becomes `font-medium`. `SectionLabel` / `MicroLabel` are sentence case. **The sidebar group headers stay in caps as the one deliberate exception** (decided 2026-11-01). Removing caps exposed Title Case source text in nine labels ("Blocked By", "Due Date"…), which are fixed. Title Case in buttons and headings elsewhere ("Save Agent", "Project Settings") is a Phase 4 copy sweep.
5. ✅ **`Popover` and `Combobox`** in `ui/popover.tsx` and `ui/combobox.tsx`, with component tests. Combobox has the `Select` trigger, the same selected-row treatment, grouped options, search with arrow-key navigation via `aria-activedescendant`, and a first Escape that clears the search before a second one closes. Adoption is Phase 2.
6. ✅ **`IconButton`** with a required `label` (tooltip and accessible name), one shape, and a shared `FOCUS_RING`, which `Button` now also uses. Adopted across the chat header. Lint gate: `cairn/icon-button-label` (`eslint-rules/cairn.mjs`) fails an icon-only `<button>` with no `aria-label`, `aria-labelledby` or `title`; the 42 it found were given labels.
7. ✅ **`SettingsRow` labelling.** Buttons, links, `Button` and `IconButton` keep their own text as their name; only form controls are labelled by the row. Component test added.

### Phase 2: Chat and session switcher (the reported pain) ✅

Branch `design/ui-pass-phase-2`, stacked on Phase 1.

1. ✅ **Session switcher rebuilt** (`SessionBrowser` dropdown mode). It's now a portalled `Popover` aligned to its trigger (at least 20rem wide), with a one-line trigger using the `Select` styling (kind icon, title, chevron; the "Chat · N sessions" line is gone) and no accent border when open. The search header matches `Combobox`. Rows are the sidebar's compact `SessionRow`, full width, with an accent-dim selection and the delete control overlaying the date on hover. **Sessions from the workspace's other projects are listed under their project names**, so a thread from another project no longer silently disappears. Group names only appear when there's more than one group. Radix handles outside clicks, Escape (clear search first) and focus return, so the hand-written document listeners only remain for the inline sidebar tree. *Why not `Combobox` itself:* session rows need focusable options for Delete/Backspace and the context menu, which an `aria-activedescendant` listbox (focus stays in the search field) can't host without hijacking Backspace. The switcher therefore reuses Combobox's surface and search header, with roving-focus rows.
2. ◐ **Drawer header rows kept as two, made consistent.** On inspection the rows hold different things. Row 1 says which session you're in, with window actions. Row 2 is that session's context: project, context-usage ring, subagents, chat settings, timeline and clear. Merging them would mean lifting per-pane actions out of `ConversationPane` instances that are CSS-hidden rather than unmounted. Instead, every action in both rows is now an `IconButton` (one shape, labelled, focus ring), with a new `pressed` state for toggles (timeline, open popovers) and a `tooltip` override.
3. ✅ **One session row style everywhere.** The two-line `SessionRow` used by the Overview's "Recent sessions" loses its left accent stripe and selects with the same accent-dim fill as the sidebar, switcher, `Select` and `Combobox`.
4. ✅ **Hand-rolled popovers migrated (9).** New session menu (`SessionPane`), note export menu, graph label mode (now a `Select`), Flow "Add node", and the popout chat's project picker (now a `Select`) go to `DropdownMenu`/`Select`. The tag colour picker, sync status panel and note tag picker go to `Popover`. `AgentSessionTab.tsx` was dead code and is deleted. Two intentional exceptions remain: the composer's `@`/`/` autocomplete in `ChatInput` (anchored to the caret, keeps input focus) and `DependencyMatrix`'s hover tooltip.
5. Also fixed: `var(--border-hover)` was used in three Flow files but never defined (the hover border did nothing); it's now `--muted`.

### Phase 3: Settings information architecture ✅

Branch `design/ui-pass-phase-3`, stacked on Phase 2.

- ✅ **One grouped rail, no subtabs.** App: General, Sidebar & views, Tags, Shortcuts. AI: Models, Chat, Coding agent, Writing style, Embeddings. Extensions: Tools, Commands, Connect other agents. Data: Device sync, Data, About. The definitions live in `settings/settings-index.ts`. Section ids stay valid for deep links (`ai` is Chat, `agents` is Coding agent), and the old `extensions`/`system` ids land on Tools and Shortcuts. Deep links now also work while Settings is already open.
- ✅ **Models page.** Community providers and local-server detection live here, once. Chat and Coding agent each keep a "Provider" row (pick, add or edit a saved provider) and their own behaviour settings. *Changed from the draft:* the saved-provider list isn't fully separated out, because `ProviderManager` couples "which one is active" with add/edit, and splitting that is a store change. The duplicated catalog and detection rows are gone, though.
- ✅ **Tags** is in the nav (it was only reachable by a legacy deep link). **Sidebar & views** split out of General. **Connect other agents** (was AI → MCP) and Tools → **MCP servers** now say which direction they go, and point at each other. The cryptic "SQLite — 1W · 3P · 38N · 65C" status is written out in words.
- ✅ **Layout.** A page header (title and one line) replaces the repeated "Cairn v3.1.7" block; the version is on About. The content column is left-aligned next to the rail (`max-w-3xl`). The app sidebar stays as you left it (an early version collapsed it to icons in Settings; dropped after review). Single-group pages got specific group titles ("Workspace tags", "Your data") so they don't repeat the page title.
- ✅ **Search.** A box at the top of the rail matches row labels, keywords and page names, best first. Enter or a click opens the page, scrolls to the row, tints it briefly (a static tint with reduced motion) and focuses its control. `settings-index.test.ts` fails if a label is renamed without updating the index. Rows and groups carry `data-settings-label`.
- ✅ **One control per number.** `StepperSettingsRow` is now a single segmented well: Auto, presets, and a custom field that shows a number only when the value is custom. A blur commits only typed input, so tabbing through no longer turns Auto off. The decorative icons are gone (the `icon` prop was removed). Component tests added.
- ✅ **Copy.** Settings group titles are sentence case, and the long descriptions (chat model, local servers, coding agent, embeddings, device sync, MCP) are cut to a sentence. The Title Case in buttons elsewhere stays for Phase 4.
- Audit: shots 32–36 (Models, Sidebar & views, Tags, search results, search jump). The pointer is now parked before each shot, so hover states don't show up as diffs.

### Phase 4: Discoverability sweep ✅

Branch `design/ui-pass-phase-4`, stacked on Phase 3.

- ✅ **Insights:** every canvas is labelled in a new `ViewTabs` strip (the Board / Archive header pattern, now a primitive; it scrolls sideways instead of hiding labels). The canvas controls sit in a second row. The ridgeline style is a `SegmentedControl` (Ridges / Overlaid / 3D), and the zoom slider and buttons are labelled. *Changed from the draft:* no "More" overflow menu; the strip scrolls instead.
- ✅ **Automations:** schedules read "Weekdays at 08:00", "Fridays at 16:00", "Every 6 hours" (`describeCron` / `describeInterval`, tested), with the raw cron in a tooltip. Run and Edit are labelled buttons, and the rest sit under "⋯". The "disabled" badge is gone: the row says "Paused" instead of a next run.
- ✅ **Top bar:** the unlabelled status/priority pills are removed (the Overview shows both).
- ✅ **Sidebar:** one Calendar entry, with a This project / All projects switch in the calendar header. The entry and its shortcut reopen the last scope used (`calendarScope`, persisted), and the all-projects calendar only takes a ⌘ number when it stands in for a hidden project calendar. The Notifications items are gone (the bell covers them). The project card's title row is the project switcher.
- ✅ **Search:** the selected chip uses the accent, keyboard hints appear once, and there's one result count.
- ✅ **Agent:** the structure panel appears once a file is open, and terminals take their colours from the theme tokens and follow theme and accent changes (`terminalTheme()` in `terminal-registry`).
- ✅ **Empty states:** titles carry no full stop, and Usage's three share one voice with a next step.
- ✅ **Copy sweep:** buttons, dialogs and headings are sentence case. Product and feature names are unchanged.

### Phase 5: Overview polish ✅ (shipped with Phase 4)

"View board" and "Open insights" use the standard `Button`, trailing arrows are gone, and the selected chips (Focus filter, Chat / Coding agent) use the accent tint. The floating composer stays as it is (confirmed 2026-11-01).

## Before/after review

Each phase is captured against the branch it stacks on:

```bash
AUDIT_OUT=before npm run screenshots:audit   # on the base branch, before changes
AUDIT_OUT=after npm run screenshots:audit    # after changes
npm run screenshots:compare                  # → design-audit/compare.html
```

`compare.html` lists every shot grouped by area, with a dot on changed ones. It has light/dark and four modes: side by side, slider, flip (click or Space) and difference (unchanged pixels go black). ↑/↓ steps through shots and 1–4 switch modes.

## Suggested PR slicing

| PR | Branch (base) | Scope | Risk |
|---|---|---|---|
| ddutchie/cairn#268 | `design/ui-consistency-pass` (main) | Phase 0: bugs, harness, dead code | Low |
| 2 | `design/ui-pass-phase-1` (Phase 0) | Phase 1: type, elevation and label codemods plus the `Popover`, `Combobox` and `IconButton` primitives. About 200 files, visual-only; review with `compare.html`. | Medium |
| 3 | `design/ui-pass-phase-2` (Phase 1) | Phase 2: chat and session switcher, plus popover migrations | Medium |
| 4 | `design/ui-pass-phase-3` (Phase 2) | Phase 3: Settings IA (deep links and `settingsSection` callers) | Medium |
| 5 | `design/ui-pass-phase-4` (Phase 3) | Phases 4–5: discoverability, copy sweep and Overview | Low per item |

Settings IA (PR 5) is a headline change for the release and earns a What's New entry in `scripts/features.config.js`. The rest goes in the changelog only.
