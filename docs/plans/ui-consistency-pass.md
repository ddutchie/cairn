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
| Overview | Drifts | Strong identity: display serif italic tagline, progress ring, task-flow bars | Most crowded type: ALL-CAPS eyebrows on every block ("NEEDS ATTENTION", "PROGRESS · NEEDS ATTENTION", "FOCUS"), mono "Showing all · 2 items", tile priority cards with uppercase labels. The accent button "Insights →" is the only arrow CTA in the app. Bottom composer overlaps content. | M |
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

Ordered so each phase is shippable on its own and the later phases get cheaper. Every phase ends with `npm run screenshots:audit` and a changelog line in `changelogs/v3.1.8.md` (or whatever is next above `package.json`).

### Phase 0: Bugs and harness (small, ship first)

1. ✅ Fix the Settings → AI crash (`AISettings.tsx` stable empty array).
2. ✅ Fix the sidebar shortcut labels. `NUMBERED_VIEWS` and `buildViewShortcutMap` in `sidebar-utils.ts` are now shared by the `page.tsx` key handler and the sidebar, so the two can't drift again.
3. ✅ Fix the "installedfor" copy (`SyncSettings.tsx:149`) and the "SAME folder" caps.
4. ✅ Make the chat view's switcher show the open thread instead of "Choose a session". The centred chat view now counts as a visible chat surface in `SessionBrowser`.
5. ✅ Delete `agent/AIChatTab.tsx` (unused).
6. ✅ Extend the audit spec: onboarding, task detail, card context menu, PRD generator, New menu, tool builder, both community catalogs, and a 900px-wide window (shots 40–64). Also give the Notes "Generate PRD" icon button an `aria-label`.

### Phase 1: Foundations (tokens and primitives, no visual redesign)

1. **Type scale.** Add five named sizes to `globals.css` / the Tailwind theme and codemod the 14 arbitrary sizes onto them:
   `text-2xs` 0.643rem (meta, kbd) · `text-xs` 0.714rem (UI default) · `text-sm` 0.786rem (body, inputs) · `text-base` 0.857rem (section titles) · `text-lg`+ (page titles, unchanged). `0.65`, `0.6`, `0.607`, `0.571` and `0.5625` fold into `2xs`. Nothing should go below 9px at scale 1.
2. **Elevation.** Three levels as tokens: `--elev-1` (cards, `shadow-sm`), `--elev-2` (menus, popovers, `shadow-lg`) and `--elev-3` (modals, `shadow-2xl`). Remove `shadow-md` and `shadow-xl`.
3. **Radius by hierarchy.** Chips and kbd use `rounded`. Controls (buttons, inputs, menu items) use `rounded-md`. Containers (cards, menus, popovers) use `rounded-lg`. Modals use `rounded-xl`. `rounded-full` is only for avatars, status dots and toggles. The chat header "+" becomes `rounded-md`.
4. **One label style.** Pick a single section-label treatment: sentence case, `text-2xs`, `font-medium`, `--text-tertiary`, no tracking. Expose it as `<SectionLabel>` in `ui/labels.tsx` and replace the 100 uppercase variants. *Decision for you: the sidebar's small caps are the most "Cairn" of the four styles, so keeping caps there only is a defensible exception.*
5. **`<Popover>` primitive.** A Radix Popover wrapper with the same surface as `DropdownMenuContent`, for rich panels (search box plus list). Add **`<Combobox>`** on top of it (trigger, search, listbox, selected check) for pickers with search.
6. **`<IconButton>`.** Require `label`, render `<Tooltip>`, and give it a visible focus ring. Lint rule (or `grep` gate in CI): no `<button>` with only an icon child and no `aria-label`.
7. **`SettingsRow` labelling.** The row clones its `id` onto whatever control it wraps and points `<label htmlFor>` at it. For inputs and toggles that's correct. For action buttons ("Browse Community", "Detect local servers", "Export", "Reset") it replaces the button's accessible name with the row title, so a screen reader announces "Community providers, button". Only forward the `id` to form controls, or add an `action` slot that doesn't get labelled.

### Phase 2: Chat and session switcher (the reported pain)

1. Rebuild `SessionBrowser`'s dropdown mode on `<Combobox>`. Make it portalled, aligned to the trigger (`align="start"`, `width = trigger` with a 20rem minimum), and give it a one-line trigger (title plus a `kind` icon; drop the "· N sessions" meta line). Use the standard select border, not an accent border, when open. Selected row gets `accent-dim` fill and a check, matching `ui/select.tsx`, with full-width rows and delete in a trailing `⋯` or the context menu. Group by project with a muted group label, so the "other project's" threads stop disappearing.
2. Merge the drawer's two header rows into one: switcher, then spacer, then `IconButton`s (new, more, collapse), all the same shape.
3. Sidebar Conversations and the switcher share `SessionRow`, so they look the same.
4. Migrate the other 12 hand-rolled popovers to `DropdownMenu` / `Popover` (most are 20-line swaps).

### Phase 3: Settings information architecture

Target structure (one rail, no subtabs, one page per task):

```
Settings
├─ General         workspace, theme, accent, chat theme, font size, note font, folder
├─ Sidebar & views view visibility (moved out of General)
├─ Models          ONE providers block (community, saved, local detection) shared by everything
├─ Chat            personality, inline AI, steps/temperature/context/output for chat
├─ Coding agent    the same knobs for the coding agent, opening with "Uses provider: X ▾"
├─ Tools           MCP servers Cairn uses + custom HTTP services + build with AI
├─ Commands
├─ Connect agents  (was AI → MCP) "Let Claude Desktop / OpenCode use Cairn", plain-language status
├─ Embeddings
├─ Writing style
├─ Tags            (currently orphaned)
├─ Device sync
├─ Shortcuts
├─ Data
└─ About           the identity header lives here only
```

- Hide the app sidebar (or collapse it to the rail) while in Settings. Remove the per-page "Cairn v3.1.7" header and left-align the content column next to the rail (`max-w-3xl`).
- Add a filter box at the top of the rail that matches row titles and descriptions and jumps to the row. Each `SettingsRow` gets an `id` for deep links, which the existing `settingsSection` deep-linking extends naturally.
- Steppers: one control per value (an input with preset chips in a dropdown, *or* a segmented control), never both stacked.
- Shorten descriptions to one sentence and move the rest into an "ⓘ" tooltip or docs link.
- Keep the legacy section ids mapped (the existing `initial*Subtab` logic) so deep links don't break.

### Phase 4: Discoverability sweep

- **Insights:** label every canvas tab (icon plus text, overflowing into a "More" menu below 1200px). Make `ridge / flat / 3d` a standard `SegmentedControl` in sentence case, and label the slider.
- **Automations:** humanise cron ("Weekdays at 08:00", raw expression in a tooltip). Show Run and Edit as labelled ghost buttons with the rest under `⋯`. Drop the "disabled" badge.
- **Top bar:** replace the bare `active` / `high` pills with a single "Status · Priority" chip with a tooltip, or remove it, since the overview already shows both.
- **Sidebar:** one Calendar entry with a project/all toggle inside the view. Drop the Notifications nav item, since the bell covers it. Merge the project card and the project picker.
- **Search:** active chip uses `accent`, one keyboard hint row, one result count.
- **Agent:** a single first-run empty state ("Open a folder to start" plus a button) instead of three. Theme the terminal background from tokens.
- **Empty states:** route all of them through `ui/empty-state.tsx` with one voice: what's missing, then the action that fixes it.

### Phase 5: Overview polish

The Overview is the most characterful screen; the aim is to keep its voice while quieting the chrome. Let the serif tagline and the task-flow bars carry it, swap the eyebrows for `<SectionLabel>`, use the standard `Button` for "Insights" (no arrow), and stop the bottom composer overlapping the last row.

## Suggested PR slicing

| PR | Scope | Risk |
|---|---|---|
| 1 | Phase 0 (bugs, harness, dead code) | Low |
| 2 | Phase 1.1–1.3 tokens and codemods (type, elevation, radius) | Medium: wide diff, visual-only; review with screenshots |
| 3 | Phase 1.4–1.6 primitives (`SectionLabel`, `Popover`, `Combobox`, `IconButton`) | Low |
| 4 | Phase 2 chat and session switcher, plus popover migrations | Medium |
| 5 | Phase 3 Settings IA | Medium: deep links and `settingsSection` callers |
| 6 | Phases 4–5 discoverability and Overview | Low per item |

Settings IA (PR 5) is a headline change for the release and earns a What's New entry in `scripts/features.config.js`. The rest goes in the changelog only.
