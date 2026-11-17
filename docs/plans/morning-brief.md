# Morning brief and connected apps — plan

**Status:** Today shipped in 3.2.0 (out of preview). Still open: connector tiers 2–3 (calendar without consent, on-device apps, signed-in web apps) and honouring MCP `readOnlyHint`.
**Started:** 2026-11-16
**Scope:** A daily, AI-written brief page (top to-dos, new updates, "push your work
forward" suggestion) built from Cairn's own data plus connected apps, and a
connector strategy that makes those briefs richer, including an optional
"signed-in web app" connector modelled on what Dia does.

## How this differs from Dia

Dia's morning brief was the starting point, but Cairn's version is deliberately
different (see "UI"):

| Dia | Cairn Today |
|---|---|
| Editorial newsletter: painting, big title | Working surface: the cairn stack is the summary, with a short lede |
| Read-only items, with one "Let's do it" | Every item has an inline action |
| Suggests what the agent *could* draft | Overnight prep has *already* drafted it, waiting for your OK |
| Flat list of updates | Lanes: Need you, Prepared overnight, Moving without you |
| No sense of time | Day strip with free blocks and **Plan my day** |
| No project view | "Since Friday" ledger per project |
| "Connect more apps" sales card | Source chips plus one contextual gap hint |

What we don't copy: importing cookies from the user's other browsers (see
"Connector strategy").

## How Dia connects to logged-in apps

From Dia's changelog (diabrowser.com/changelog), Dia is a **hybrid**:

- **Session-based (early, quick wins):** Slack was read by scraping the
  signed-in web app ("Slack page scrapes now complete faster"). Outlook/Teams
  started as "pinned Outlook and Teams URLs". Notion was scraped until Oct 2026.
- **Moving to official APIs/MCP:** Notion moved to its API (Mac 1.51.0).
  Atlassian moved to Atlassian's remote MCP v2 (Mac 1.57.0, 12 Nov 2026).
  OAuth/MCP credential recovery landed in 1.56.0.
- **Auto-connect** (Mac 1.55.0): an opt-in preference that "automatically
  connects supported logged-in apps", that is, it sees you're signed in to a tab
  and either uses that session or starts a low-friction OAuth flow.

Dia's edge is that it *is* the browser, so the user's session is already there.
Cairn is not the user's browser, so the cheap version of that trick isn't
available to us. Chrome 127+ App-Bound Encryption (and Edge's equivalent) means
reading another browser's cookies on Windows needs infostealer techniques. That's
out of the question.

## Connector strategy (tiers)

Ship in this order. Each tier works without the ones after it.

### Tier 0: Cairn-native (no connection needed)

Board cards (due dates, In Progress, stalled in Review), recent notes, Idea Flow
activity, automation runs and failures, agent sessions awaiting the user, and
git state of linked repos (unpushed branches, open PRs via `gh` if present).
`shared/overview/review.ts` (`buildReview`, `upNext`) already does part of this
offline. The brief extends it.

### Tier 1: MCP connectors (existing stack)

Cairn already has per-workspace MCP servers with PKCE OAuth
(`electron/lib/mcp-oauth.ts`), loopback redirect, and `safeStorage` tokens
(`electron/lib/secure-store.ts`). The only missing piece is **presets**: a
curated list of known remote MCP servers so "Connect Slack" is one click instead
of pasting a URL.

| App | Route | Notes |
|---|---|---|
| Atlassian (Jira, Confluence) | Atlassian remote MCP | What Dia uses now. 3LO OAuth, usually allowed in enterprise |
| GitHub | GitHub remote MCP | Easy OAuth |
| Slack | `mcp.slack.com` | Needs a pre-registered client id (mcp-oauth already supports it). Workspace admin approval |
| Outlook, Teams, calendar | Microsoft Work IQ MCP or Graph | **Admin consent is the blocker.** Microsoft's managed consent policy (MC1097272, widened Nov 2025) blocks user consent for mail/calendar/Teams scopes |
| Google (Gmail, Calendar, Drive) | Google APIs via a custom service, or a community MCP | Restricted Gmail scopes need Google verification + a yearly CASA audit if *we* ship the client id. Fine if the user brings their own |

### Tier 2: Calendar without consent

- ICS feed URL (Outlook and Google both publish one, though tenants often disable it).
- macOS EventKit via a tiny native helper (permission prompt, no tenant consent).
- Windows: `Windows.ApplicationModel.Appointments` is limited. Classic Outlook
  COM is a dead end with the new Outlook. Skip for now.

### Tier 2b: On-device apps and accounts

Dia's evidence points to the *account* rather than the desktop app. Slack search
works "whether you're using Slack in browser or app", and Outlook/Teams arrived
as "pinned URLs". Still, there are real options for using what's already signed
in on the device:

- **Device SSO through the OS broker (best option for Microsoft):** MSAL Node
  with the native broker plugin (`@azure/msal-node-extensions`) uses Windows
  WAM and macOS Enterprise SSO. Cairn silently gets a Graph token for the
  work account already signed in to Windows or Office, with no password and no
  browser. This is still an official path. It needs a Cairn app registration,
  and admin consent may still apply. It does remove the sign-in friction, and in
  tenants that pre-approve it, it's seamless. Never borrow a Microsoft
  first-party client id.
- **Classic Outlook through COM (Windows):** `Outlook.Application` reads mail
  and calendar from the local OST, with no tenant consent, through a small
  PowerShell or `winax` helper. This only works while classic Outlook is
  installed. The new Outlook (`olk.exe`) is a WebView2 wrapper around OWA with
  no COM. Some setups show an "a program is trying to access" prompt.
- **Mac:** EventKit already sees Exchange and Google calendars added to
  Calendar.app. Mail.app and legacy Outlook for Mac support AppleScript.
- **OS notification feed ("what pinged you"):** Windows
  `UserNotificationListener` (official, user-granted, needs package identity)
  shows toasts from Outlook, Teams and Slack desktop. That's a cheap,
  cross-app "new updates" signal with sender and preview text. macOS has no
  public equivalent (the usernoted DB is TCC-protected), so this is Windows only.
- **Not doing:** reading Slack or Teams desktop local storage or LevelDB
  tokens, or driving apps through UI Automation or Accessibility. The first is
  infostealer territory, and the second is fragile and intrusive.

### Tier 3: Signed-in web app connector (experimental, opt-in)

This is the Dia-style option for when Tier 1 is blocked by IT. Design:

- **Sign-in window:** a separate `BrowserWindow` with a `WebContentsView` on
  `session.fromPartition("persist:connector-<id>")`. The user signs in once to
  `outlook.office.com`, `app.slack.com` or `teams.microsoft.com`. The main
  window keeps its nav guard (`electron/lib/window-nav-guard.ts`) unchanged.
  This window has its own allowlist of the connector's origins only.
- **Hardening:** `sandbox: true`, `contextIsolation: true`, no preload with
  IPC access beyond a single read-only `extract` channel, `nodeIntegration`
  off, permission requests (camera, notifications, downloads) denied.
- **Gathering:** at brief time, load the app in a hidden view on that
  partition and run a **per-site extractor** (a small, versioned script that
  reads the inbox, unread channels or the calendar day view and returns
  structured JSON). Read-only: no clicks that send, mark read or accept. Slack's
  "doesn't mark as read" behaviour in Dia is the bar.
- **Extractors are data, not code we hand-maintain per release:** ship them
  as a versioned manifest (like `community-registry.ts` does for automations)
  so a DOM change is a manifest update, not an app release.
- **Health:** each run reports `ok | signed-out | extractor-broken`. A broken
  extractor marks the source stale in the brief instead of failing it.
- **Labelling:** settings say plainly that this reads the web app as you, may
  break, and may conflict with your organisation's policies. Off by default.

**Risks to accept or reject before building Tier 3:**

- Many ToS forbid automated access. Some enterprise Conditional Access
  policies (device compliance, token protection) will refuse or flag an Electron
  user agent. It also deliberately sidesteps an IT consent control.
- Session cookies in the partition become a high-value secret on disk
  (Chromium encrypts them with DPAPI or Keychain, the same as a browser).
- Extractors break silently. Health reporting is mandatory, not polish.

## Brief architecture

```
HeartbeatScheduler (cron "0 7 * * 1-5", workspace tz)
  └── runBrief(workspaceId)                       electron/lib/brief/runner.ts
        ├── gather: Source[] → BriefItem[]         electron/lib/brief/sources/*
        │     ├── cairn-native (sync, offline)
        │     ├── mcp:<serverId> (read-only tool calls)
        │     ├── ics:<url>
        │     └── web:<connectorId> (Tier 3 extractor)
        ├── rank + write: runOneShot(JSON schema)   electron/agent/one-shot.ts
        └── persist: briefs table + optional note   electron/db/brief-queries.ts
Renderer: Today view (TodayView, sidebar entry) ← ipc brief:get / brief:generate
```

### Entry point: an always-visible Overview tab, run by an automation (superseded by "Workspace Today")

**Decided (2026-11-16):** the **Today tab is always shown** in Overview, next
to Summary. When Today is off, the tab shows its setup (refresh time, weekdays,
the connectors it will read, **Turn on and run now**). Hiding the tab behind a
toggle in Automations would make it impossible to discover. The tab's
**Schedule** menu changes the time or turns it off.

Underneath, it's still an automation: one row per **project**, marked with
`communityId = "cairn:today"`, created on first enable. Being per project
matches where the tab lives and how connectors are attached (project or
global). It shows in Automations as "Today", with run history, the run log and
the daily budget, like any other automation.

### First implementation (parts superseded by "Workspace Today" and "As shipped in 3.2.0")

What was built first, and what's different from the full design below:

- **Gathering is agent-driven, not adapter-driven.** The Today automation
  runs the normal heartbeat runner with a fixed recipe (`TODAY_RECIPE` in
  `electron/lib/today.ts`). The agent uses whatever connector tools are
  attached (Slack, Work IQ, GitHub, Atlassian…) and ends with one JSON
  object. `shared/today/brief.ts` parses and normalises it. There are no
  per-connector adapters yet. (Superseded: the run now builds the brief with
  brief tools; see "Workspace Today".)
- **Read-only gate:** the automation runs in `ask` mode, and the runner
  answers every ask itself (`todayAllowsTool`, `todayToolFilter`). Cairn read
  tools, the brief tools, `skill`, `todo_write` and the MCP resource tools
  pass. Local file reads (`read`, `grep`, `glob`) and `web_fetch` are left out:
  the run reads untrusted messages, and with both it could be talked into
  reading a file and sending it to a URL. Connector tools pass only when their
  operation name reads like a read (`search_`, `get_`, `list_`, `ask`…) and
  contains no write verb (`WRITE_VERB` in `shared/today/route.ts`). Asks
  raised by a hook, a rule or a sandbox escalation are denied, since nobody is
  there to review them. MCP tools carry no reliable read-only flag in Cairn
  yet, so this is a name heuristic. Honouring MCP `readOnlyHint` annotations
  is the follow-up, and custom services (which record an HTTP method) could be
  limited to GET.
- **Storage:** briefs are saved as JSON in the automation's durable
  `out/today/<date>.json`. There's no `briefs` table yet.
- **Actions:** done marks and draft edits are saved next to each brief
  (`out/today/<date>.marks.json`, through `today:mark`); the old localStorage
  marks are moved over once. **Send with
  Cairn** hands a draft to chat, which asks before posting. There's no overnight
  prep run yet: drafts are written during the same morning run. There's no
  "Since Friday" ledger.
- The run gets at least 30 steps (`TODAY_MIN_STEPS`).
- **v3 layout (brief version 2):** the model writes a verb-first `headline`
  (at most 10 words) and a short `lede` with no counts. Each `needYou` item is
  a `decision` (a question with 2–3 `choices`, each optionally linked to a
  draft by `draftId`) or a `todo`, with up to 3 `facts` chips. Cairn, not the
  model, computes the day: `dayBlocks()` splits free time at "now", marks the
  best remaining block and returns the totals the four header tiles show.
  Drafts linked from a choice sit on that choice and are left out of
  **Prepared for you** unless the user asks to see all drafts. Saved briefs
  are re-normalised when read, so version 1 files still load.
- **Act panel** (`today-act-panel.tsx`): answers, drafts and Ask Cairn open
  a dialog over Today with its own chat thread (`today-<workspace>-<date>-<item>`,
  not listed until **Keep in chat**). `today:route` (`shared/today/route.ts`)
  picks the channel from the item's source and lists connector tools in the
  item's project scope whose operation reads like a send on that channel.
  Send runs one chat turn with the `safe` approval policy, so the send call's
  approval card (tool and arguments) shows in the panel.
  - The chat can change Cairn when asked (cards, notes) but sends nothing
    outside Cairn until **Send**. The message logged is what the user typed;
    the instructions around it go as model-only `context` on the chat prompt.
  - A finished connector write marks the item done, and so does a Cairn write
    after **Send** (board items). Done is latched in the panel, so it holds
    after the turn ends and the live tool calls clear.
  - Reopening an item restores its chat from the session log and picks up a
    reply still running. Closing mid-reply keeps the thread in the chat list
    and reloads it when the turn ends (`reloadThreadMessages`).
  - The send check is the same name heuristic as the read-only gate; MCP
    `readOnlyHint`/`destructiveHint` annotations would replace both.

### Workspace Today (built on `feature/today-brief`)

**Decided (2026-11-16):** Today becomes a workspace view with its own sidebar
entry, not an Overview tab. In practice there's one brief per person, since a
workspace belongs to one user.

- **One automation per workspace:** a Today row with `projectId` null. The old
  per-project Today rows are deleted when the workspace one is turned on.
  Settings live in the automation folder (`today.json`): the projects to
  include, which apps to read (by connector server id), and the schedule.
- **Connector scope:** each included project resolves its own attachments
  (global plus its own, where its disables win), then the projects are
  combined. Apps turned off are dropped from the scope itself
  (`ToolScope` `{ projects, exclude }` in `electron/lib/external-tools.ts`), so
  they're never connected, described in the system prompt or called.
- **Brief tools, not one JSON answer:** the run gets `today_read`,
  `today_upsert` (one item at a time: a decision, to-do, draft, FYI or event,
  each with a stable id built from its source), `today_remove` and
  `today_finish` (headline, lede, focus, sources and gaps). Each call saves the
  brief and sends `today:updated`, so the view fills in while the run gathers.
  Items the user already finished or dismissed keep that state across
  refreshes (a same-day run starts from the saved brief; `startRefresh` in
  `shared/today/brief-edit.ts`). There's no JSON fallback: the recipe and the tool descriptions
  tell the model how to use them. Writes go only to the brief file, so the gate
  allows them.
- **Cairn computes the project facts:** due today, overdue, in review, stale
  for 5+ days, failing automations and recently edited notes, for each included
  project. These show in **Your projects**, and the model gets them as context.
  The model doesn't need to search the board to find them.
- **Sidebar entry:** Today sits above Automations (in both the rail and the
  expanded sidebar) and shows whether a run is gathering or a brief is ready
  and unread.
- **Usage:** Today runs record usage as their own source, **Today brief**, not
  as "automation".

### As shipped in 3.2.0

- **Carry-over and history:** a new day's run starts from the last brief's
  open decisions, to-dos and drafts (with `since` and draft edits). A
  same-day refresh first saves the version it replaces as
  `history/<date>@<HHMMSS>[-N].json` (never overwritten). Files older than
  30 days (`TODAY_KEEP_DAYS`) are pruned when a run starts; the previous
  brief's marks are read before that.
- **Look-back:** each run looks back from the start of the last run that
  finished (`todayLookBackFrom`), so a failed run doesn't narrow the next.
  **Rebuild brief** forces 24 hours (72 on a Monday); the flag is taken at
  the very start of the run, before any skip.
- **Cost and speed:** low reasoning effort (`todayReasoningEffort`), connector
  results cut at 16,000 characters, at least 30 steps. Today's spend
  (`source = 'today'`) counts toward the daily automation budget.
- **Failure:** a brief that can't be saved fails the tool call and the run,
  and Today shows why (`saveError` on `today:updated`). A run that fails or
  stops early closes what it found. Today is retried once after a failure and
  never auto-paused, unlike other automations.
- **Approval notices:** an approval or question in a session no window is
  showing goes to the notification bell even while Cairn is focused
  (`session:on-screen`, `electron/lib/session-on-screen.ts`). The Today run
  itself never waits on the user.
- **Prompt:** Today has its own system prompt (`TODAY_SYSTEM_PROMPT`: unattended,
  read-only, report gaps rather than guess) instead of chat's. The recipe is in
  sections (calendar, communication, work tracking, projects, carried items,
  drafts, writing) and names no single app. The calendar is read for the whole
  of today on every run, in its own call, today's date only. Work tracking asks
  for what's new and for what's open (assigned and not done, reviews waiting),
  and communication looks back 7 days for unanswered questions, so older work
  isn't missed. Cairn computes the look-back time (local, ISO with offset,
  Unix seconds); a model's own Unix time was once a year out.
- **Speed:** the first round's searches go out together and Today's connector
  calls run in parallel (`externalParallel`; chat keeps them one at a time).
- **Web search:** a web search connector is off for Today until the user turns
  it on (`webApps` in Today's settings, with a hint in the Apps list), since a
  query can carry what the run read elsewhere to that service.
- **Run notes:** the run's closing message is kept with the brief (`note`) and
  shown behind **Run notes** in the header.
- **Priority and lane size:** need items carry `priority` (high, normal, low),
  kept in that order. Need you holds 15 (`TODAY_LANE_LIMITS`), the view shows
  `TODAY_NEED_SHOWN` (6) and folds the rest. A full lane turns the new item
  away instead of telling the run to remove one, and `today_remove` keeps a
  carried item unless it gets a `reason`. Events carry a `date` and other days
  are turned away.
- **Debug export:** `cairn-today-debug/3` holds the last run's setup (model,
  effort, system prompt, tools with their schemas), its exact prompt, the
  prompt and system prompt the current build would send next, and per-step
  timings. `scripts/today-replay.mjs` replays an export against any
  OpenAI-compatible endpoint (env `TODAY_LLM_BASE_URL` / `_API_KEY` /
  `_MODEL`), answering connector calls from the recorded results or a fixture
  file, so prompt and effort changes can be tried without the app.
- **Known gaps:** no wall-clock limit on a stalled run (all automations); the
  brief's date uses the computer's timezone while the schedule uses the one
  saved at setup; reopening an item doesn't show an approval card that was
  pending when it closed.

### Gathering from MCP: deterministic first, agent as fallback

- **Known presets** get a small adapter that calls specific tools with fixed
  arguments. For example, Atlassian `searchJiraIssuesUsingJql` with
  `assignee = currentUser() AND updated >= -1d`, GitHub "PRs awaiting my review"
  and Slack "mentions since yesterday". This is cheap and predictable, and it
  keeps tool output out of a long agent loop.
- **Unknown MCP servers** fall back to a bounded agent run through
  `runEngineAutomation` with a **read-only gate**. Writes are denied, not asked
  (a new `decide()` profile, so an unattended 7am run never stalls on approval),
  with a tool-call cap and a token budget, returning `BriefItem[]`.

### `BriefItem` (in `shared/types/brief.ts`)

```ts
type BriefItem = {
  id: string;               // stable: source + external id, for dedupe across days
  source: string;           // "board" | "mcp:atlassian" | "web:slack" | ...
  kind: "todo" | "update" | "event" | "commitment";
  title: string;
  body?: string;
  url?: string;             // deep link back to the source
  people?: string[];
  at: string;               // ISO time of the underlying event
  topic?: string;           // the italic tag in Dia ("Axiom", "Quality")
  raw?: unknown;            // trimmed source payload for the writer prompt
};
```

### Writing step

There is a single `runOneShot` call with a JSON-schema response:
`{ greeting, pushForward: { title, body, sessionSeed }, todos[], updates[] }`.
Each output entry must cite `BriefItem.id`s. Entries without a valid citation
are dropped, which is what keeps the model from inventing "Chris said...". Items
already shown in yesterday's brief are passed in as `seen` so "New updates" means
new.

### Storage

There's a new `briefs` table holding `id`, `workspace_id`, `date`,
`generated_at`, `status`, `payload` (JSON), `sources` (per-source health) and
`model`. There's one row per workspace per day. Regenerating replaces the row,
and older rows stay for history. A setting can also save each brief as a note in
a `Briefs/` folder (reusing the `ReviewButton` note path).

### UI

Prototype: `morning-brief-prototype-v2.html` (scratch). The first prototype
copied Dia's editorial layout and has been dropped.

**Principle:** Dia's brief is something you read. Cairn's **Today** is
something you work from. Every item has an action. The agent has already done
the first pass, and the page is built out of Cairn's own concepts (lanes,
cards, sessions, projects) rather than a newsletter.

- **Today view** (superseded the Today tab in Overview): a workspace view with
  its own sidebar entry above Automations. While Today is off it shows a setup
  screen.
- **Header: the cairn is the summary.** A stack of four stones, each one a lane,
  sized by weight. The top stone (accent colour) is today's single focus.
  Clicking a stone jumps to its lane. Next to it, a one-paragraph lede in the
  display serif: what needs you, what's prepared, and where your time is. There's
  no painting, no hero image and no big title.
- **Your day:** a 07:00–19:00 strip built from the calendar plus board estimates.
  Free time shows as dashed blocks, and clashes are highlighted. **Plan my day**
  drops focus items into the free blocks. That's a local plan only; nothing is
  written to the calendar.
- **Three lanes** (a board, not a list):
  - **Need you:** decisions only. Each item has inline actions (approve a paused
    agent session, open a review, put it in a time slot) and a one-line "why"
    explaining its rank.
  - **Prepared overnight:** the differentiator. An optional 02:00 prep run uses
    Cairn's agent engine to draft PR review notes, replies to things you
    promised, and card breakdowns of new plan notes. Drafts are shown inline,
    with Post, Edit and Discard. Nothing is sent or changed until you click.
    Writes go through the normal approval gate at click time.
  - **Moving without you:** a compact FYI feed with status dots.
- **Since Friday:** a ledger table per project, with a 7-day sparkline, counts
  for done, new, stale and notes, and a one-line headline. It reuses
  `useProjectMetrics`.
- **Built from:** source chips, missing sources shown dashed, and agent time
  and tokens spent. There's at most one contextual gap hint ("your 11:00 has no
  agenda: connect Outlook on this PC") instead of a "connect more apps" sales
  card.
- Follows the styling rules: `SectionLabel`, `IconButton`, the type scale and
  `shadow-elev-*`. Stone colours become theme tokens.

### Privacy

- Per-source toggle "include in brief".
- A clear note that gathered content is sent to the configured LLM provider. A
  local model works too.
- Raw payloads are trimmed before the prompt and never stored beyond the brief
  row.

### Next: "Worth reading" and your own request (planned, after 3.2.0)

Users want more than what needs them: headlines in their field, and the
documents a run comes across. Two parts:

- **"Also include" in Today's settings.** A free-text request added to every
  run ("Give me the latest AI news stories", "Anything new in the Viewer
  space on Confluence"). Stored with the Today settings, shown in the export.
- **A "Worth reading" section.** Full width, under the lanes. Each card has a
  title, source, link and a one-line summary of why it's there, and the site's
  favicon. No remote images: loading a news site's image tells it who opened
  the brief. Items come from two places:
  - the main run, for internal documents it came across (a Confluence page
    that came up in a search, a doc shared with the user), using a new
    `reading` lane in `today_upsert`;
  - a separate web pass, for the user's request when it needs the web.

**Keeping the read-only promise.** Web tools never share a pass with private
data. The web pass is its own engine session, run alongside the main one, that
gets only the user's request and the web search apps they turned on. It sees no
Slack, mail, boards or brief, so a query can't carry their content out, and a
page that tries to steer it can at worst put junk in "Worth reading". The main
run keeps web tools out, as it does now unless the user turns them on; once the
web pass exists, the `webApps` switch moves to "Used only for your request" and
the main run never gets web tools.

**Work:**
- `TodaySettings.request` (string, capped) and the settings box with a short
  hint on what it can and can't reach.
- `reading` lane in `shared/today/brief.ts` (normalise, cap at about 6, id from
  the URL), its tool schema and prompt rules ("only what's worth the user's
  time today; no duplicates of items in other lanes").
- The web pass in `heartbeat-runner.ts`: a second `runEngineAutomation` with
  its own session id, the web tools only, a short recipe built from the
  request, low effort and a small step cap. Its items merge into the brief by
  id; its failure is a source line, not a failed run.
- The section in `today-view.tsx`, history and carry-over rules (reading items
  don't carry to the next day), the export and the replay script (the web pass
  replays from its own recorded results).
- Changelog and a What's New highlight.

**Open:** whether the request also steers the main run (for example "watch
the Viewer space"), or only the web pass. Starting with both: the main run
reads it as one more thing to gather from the user's apps, and the web pass
covers what needs the open web.

### Follow-ups and research (after 3.2.0)

Found while testing 3.2.0 against real runs. Ordered by how much each would
change the brief.

**Research first**
- **MCP tool annotations instead of verb guessing.** The MCP spec lets a
  server mark each tool `readOnlyHint`, `destructiveHint` and `openWorldHint`.
  Cairn doesn't read them today (nothing in `electron/` mentions them), so
  Today's gate guesses from operation names (`WRITE_VERB`, `READ_VERB`,
  `isWebOperation`) and the web-app switch guesses from the app's name. Find
  out which of the servers users connect (Slack, Atlassian, Work IQ, GitHub)
  set the hints and whether they can be trusted, then use them where present:
  read-only by annotation, web by `openWorldHint`, name rules only as the
  fallback. Custom services already have an HTTP `method`; GET-only services
  could be read-only by that.
- **Connector latency.** In every test run the model took about 10 seconds
  and Work IQ about 30 per call, so a run is about 40 seconds of waiting. Two
  Work IQ questions sent at once came back together, which suggests the server
  answers one at a time. Measure per-server latency from run logs, check
  whether Work IQ serializes per conversation, and decide between one combined
  question (faster, but the calendar answer was lost once when combined),
  starting the calendar call before `today_read`, or showing each lane as its
  source answers.
- **How other models handle the prompt.** All tuning so far used one model at
  low effort. Run the replay script over the same exports with two or three
  other models and efforts (`--effort`), and check that `reasoningOption` sends
  effort in the form each API expects.
- **A repeatable check for prompt changes.** Exports hold personal data and
  stay out of git, so they can't be test fixtures. Build a few synthetic
  exports (a quiet day, a busy day, a calendar refusal, no calendar app, a
  Monday) and a small scorer over the replay output: events only for today,
  sources for every area, look-back used, no web tools, item caps kept. Run it
  by hand before changing `TODAY_RECIPE`; CI only if it can run without a key.

**Smaller fixes**
- **Unanswered questions.** Slack and mail search can't say "unanswered"; the
  model judges from the replies it sees. Check which tools expose read/replied
  state and say so in their prompt hint; drop items the user already answered
  in another app (the same request often arrives in Slack and mail).
- **Server instructions in run notes.** A server's `initialize` instructions
  ("tell the user to upgrade this endpoint") end up in the run notes every run.
  Show them once per server, or as a notice in Settings, not in the brief.
- **Stale open work.** The open-work search found only issues from 2022–23 and
  left them out, which was right. If a tracker is full of these, cap by age or
  ask the user once whether to hide them.
- **Known gaps carried from 3.2.0:** no wall-clock limit on a stalled run, the
  brief's date uses the computer's timezone while the schedule uses the saved
  one, and reopening an item doesn't show an approval that was pending when it
  closed.
- **Windows unit tests:** 15 engine tests (hooks, sandbox, ripgrep, LSP) fail
  on Windows; ddutchie/cairn#306 fixes them.

## Phases

1. **Native brief:** the Tier 0 sources, `briefs` table, the built-in
   Today automation (toggle, schedule, settings), the Today view (header
   stack, lanes, ledger) and the writer step. Usable on its own.
1b. **Overnight prep:** the 02:00 prep run (drafts only, read-only connectors,
   nightly token budget) and inline Post/Edit/Discard through the approval gate.
   Also the day strip once a calendar source exists.
2. **MCP presets + adapters:** preset catalogue, one-click connect, Atlassian,
   GitHub and Slack adapters, "connect more apps" card.
3. **Generic MCP gathering:** read-only engine profile, bounded agent run for
   unknown servers.
4. **Calendar and device accounts:** ICS feeds, macOS EventKit, then Microsoft
   Graph through MSAL with the WAM/Enterprise SSO broker (silent device sign-in).
   Classic Outlook COM and the Windows notification listener come after that as
   Windows-only extras.
4b. **Worth reading:** the "Also include" request, the `reading` lane and the
   separate web pass (see "Next: Worth reading and your own request").
5. **Tier 3 web connectors (experimental):** partitioned sign-in window,
   extractor manifest, health reporting. Outlook and Teams first, since that's
   where enterprise consent blocks Tier 1 most often.

Each phase gets a changelog entry. Phase 1 gets a What's New card.

## Open questions

- **Scope:** decided: one brief per workspace, with project chips on items
  (see "Workspace Today"). An "all workspaces" option may come later.
- **Tier 3 go/no-go:** given the ToS and Conditional Access concerns, do we
  build it at all, or stop at Tier 2 and document "ask IT to approve the MCP
  app"?
- **Shared client ids:** do we register Cairn's own OAuth apps (Slack,
  Microsoft, Google) or require bring-your-own? Shared ids are smoother but put
  Cairn through Google verification and Microsoft publisher verification.
- **Mobile:** should the generated brief sync to mobile as read-only?
