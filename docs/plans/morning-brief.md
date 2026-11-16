# Morning brief and connected apps — plan

**Status:** in progress (preview on `feature/today-brief`)
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
Renderer: Overview → Today tab (TodayPanel) ← ipc brief:get / brief:generate
```

### Entry point: an always-visible Overview tab, run by an automation

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

### Preview implementation (`feature/today-brief`)

What was built, and what's different from the full design below:

- **Gathering is agent-driven, not adapter-driven.** The Today automation
  runs the normal heartbeat runner with a fixed recipe (`TODAY_RECIPE` in
  `electron/lib/today.ts`). The agent uses whatever connector tools are
  attached (Slack, Work IQ, GitHub, Atlassian…) and ends with one JSON
  object. `shared/today/brief.ts` parses and normalises it. There are no
  per-connector adapters yet.
- **Read-only gate:** the automation runs in `ask` mode, and the runner
  answers every ask itself (`todayAllowsTool`). Cairn and engine read tools
  pass. Connector tools pass only when their operation name reads like a read
  (`search_`, `get_`, `list_`, `ask`…) and contains no write verb. Everything
  else is denied. MCP tools carry no reliable read-only flag in Cairn yet,
  so this is a name heuristic. Honouring MCP `readOnlyHint` annotations is the
  follow-up.
- **Storage:** briefs are saved as JSON in the automation's durable
  `out/today/<date>.json`. There's no `briefs` table yet.
- **Actions:** done and discard are local (localStorage, per day). **Send with
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
  a sheet over Today with its own chat thread (`today-<project>-<date>-<item>`,
  not listed until **Keep in chat**). `today:route` (`shared/today/route.ts`)
  picks the channel from the item's source and lists in-scope connector tools
  whose operation reads like a send on that channel. Send runs one chat turn
  with the `safe` approval policy, so the send call's approval card (tool and
  arguments) shows in the panel. A finished write call marks the item done.
  This is the same name heuristic as the read-only gate; MCP
  `readOnlyHint`/`destructiveHint` annotations would replace both.

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

- **Today tab in Overview** (`src/components/layout/project-overview/`), first
  in the tab order. It only shows while the automation is on.
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

## Phases

1. **Native brief:** the Tier 0 sources, `briefs` table, the built-in
   Today automation (toggle, schedule, settings), the Overview Today tab (header
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
5. **Tier 3 web connectors (experimental):** partitioned sign-in window,
   extractor manifest, health reporting. Outlook and Teams first, since that's
   where enterprise consent blocks Tier 1 most often.

Each phase gets a changelog entry. Phase 1 gets a What's New card.

## Open questions

- **Scope:** should there be one brief per workspace, or one across all
  workspaces with project tags (like the "Axiom" and "Quality" tags)? The
  proposal is one per workspace, with an "all workspaces" option later.
- **Tier 3 go/no-go:** given the ToS and Conditional Access concerns, do we
  build it at all, or stop at Tier 2 and document "ask IT to approve the MCP
  app"?
- **Shared client ids:** do we register Cairn's own OAuth apps (Slack,
  Microsoft, Google) or require bring-your-own? Shared ids are smoother but put
  Cairn through Google verification and Microsoft publisher verification.
- **Mobile:** should the generated brief sync to mobile as read-only?
