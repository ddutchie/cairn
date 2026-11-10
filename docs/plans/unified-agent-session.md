# One agent session — plan

> Branch: `feat/staged-tools-default` · 2026-11-09 · Status: **step 1 measured (stays opt-in), step 2 draft for review**
> Builds on `docs/plans/agent-engine-design.md` and on #279 (prompt-cache fixes and the staged-loading spike).

## Where we are

Chat, coding and automations already run through one loop (`runTurn`). What still differs per
surface is decided in `electron/ipc/engine-bridge.ts`: the tool list, the system prompt, the
approval profile and the working directory. The user picks the surface up front (a chat thread or
an Agent session) and cannot move between them.

The goal is one kind of session. It starts light and loads tools when the work calls for them,
without paying for it in prompt-cache re-writes.

## The constraint: prompt caching

Providers cache a request by its prefix, in the order tools → system prompt → messages. Any change
in that prefix re-writes the cache for everything after it. So:

- The tool list only grows, in a fixed order, and never shrinks (`agent/toolbox.ts`).
- Nothing that changes during a session goes in the system prompt. Mode switches, the approved
  plan and similar notes travel with a prompt as model-only context.
- Request-time pruning cuts from the start of the history in large steps.

Enabling a group costs one cache re-write. Measured on DeepSeek, the request right after
`enable_tools` still read the unchanged part of its prefix from cache.

## Step 1 — staged loading for coding sessions: measured, stays opt-in

The plan was to turn staged loading on by default for coding sessions. The measurement says not to.

Coding toolset, built-in tools only (chars ÷ 4, this repository, 2026-11-09):

| | Tools | Tokens |
|---|---|---|
| Full list | 54 | 10,743 |
| Staged (core + code + `enable_tools`) | 43 | 9,841 |
| Extended group (deferred) | 12 | 1,064 |
| `skill` catalogue alone | 1 | 3,585 |

With reminders enabled the extended group is 15 tools and 1,240 tokens.

- **The saving is about 900 tokens a request, 8%.** A caching provider bills cached input at
  roughly a tenth, so the real saving is near 90 token-equivalents per step.
- **One late `enable_tools` costs more than that.** It re-writes the cache for the whole
  conversation: with 20k tokens of history, about 23k token-equivalents, or some 250 steps of saving.
- **So for this group staging loses on cost** in any session that turns it on late, and gains
  almost nothing in one that never does. Eleven fewer tools to choose from is the only benefit left.

Staging pays when the deferred group is large and is turned on early, while the history is
small. That is the chat → code case in step 2 (about 6,500 tokens deferred, enabled at the start
of the coding work), not this one.

What step 1 delivers instead:

| Item | What | Status |
|---|---|---|
| Auto-load on first use | A call to a tool in a group that is not loaded turns the group on and asks the model to call again, instead of "Unknown tool". Step 2 needs this for models that skip `enable_tools`. | done |
| Default | Stays off: `agentConfig.stagedTools` or `CAIRN_STAGED_TOOLS=1` opts in. | decided by the numbers above |
| `skill` catalogue | Out of the tool definition; short list sent once as context (below). | done |
| Weak-model check | A live run on the weakest model in regular use. The local Ornith endpoint was down on 2026-11-09; the bridge model on `:3042` found `enable_tools` unprompted. | open |

### The `skill` catalogue: moved out of the tool definition (done)

The catalogue was a third of the coding tool tokens in this repository (24 skills, 3,516 tokens),
in a tool description that changed whenever a skill file did. Now:

- The `skill` tool has a fixed description (under 100 tokens) and the same definition whatever
  skills exist. Called with no name it returns the full list; skills are read at call time, so one
  added during a session is found.
- A session gets a short list once as standing context: one line per skill, the first sentence of
  its description clipped to 160 characters (about 1,000 tokens here). It is sent again only when
  it is no longer in the model's view (after compaction) or when the list changes, and then it is
  appended, so the cached prefix is untouched.

Net: about 3,400 fewer tokens in the tool list on every request, about 1,000 added once to the
conversation, and skill edits no longer re-write the cache.

Two things to watch:

- **Skills may trigger less often.** The model now picks from a one-sentence summary instead of
  the full description. Not measured; a live comparison is open.
- **Subagents get no list.** They carry the `skill` tool but not the session's context, so they
  have to call it with no name first.

Groups today (`buildToolParts`):

- **core** — Cairn data tools, session search, subagents, `exit_plan_mode`
- **code** — file tools, `bash`, background jobs, `web_fetch`, `todo_write`, `skill`
- **extended** — terminals, LSP, goal, reminders, workflows
- **external** — connector (MCP) tools, always last

## Step 2 — one session type

Design-heavy; its own PR, after the two decisions below are confirmed.

### Decisions (recommended, to confirm)

| Topic | Recommendation | Why |
|---|---|---|
| Working directory | Ask with a folder picker the first time a session enables code tools, and remember it on the project. | Projects store no code folder today. The notes folder is unsafe: file edits there bypass SQLite. |
| Approvals | Keep the coding presets (ask / auto / allow all) for every session. Map chat's `safe` to `ask`, `allow-all` to `allow all`, and keep `external` as a rule on top of `ask`. | The two systems already behave almost the same; one is easier to explain. |

### Engine

1. **Session profile.** One profile replaces `chat` / `coding`. `automation-dev` and headless
   automation runs stay separate: they are restricted on purpose.
2. **Groups.** A new session starts with core only. `code` becomes a group like `extended`.
   Sessions started from a task or a code folder enable `code` up front, so they behave as today.
3. **Working directory.** `enable_tools("code")` needs a folder. With none bound, the tool asks
   the user (a card like an approval), binds the answer to the session and stores it on the
   project. File tools are built when the folder is known, not at session start.
4. **System prompt.** One base prompt. The board-tracking workflow from the coding prompt moves
   into the context sent when `code` is enabled, so a session that never codes never reads it.
5. **Storage.** Chat threads (`chat-<threadId>`) and coding sessions keep their ids and logs;
   both are already `cairn-session/1`. The session row gains what it lacks (a nullable folder).

### Renderer

1. One "New session" entry point; no surface choice. Plan mode and the permission preset stay.
2. The Chat and Agent views merge into one conversation view. The coding extras (todo list, jobs
   dock, terminals, plan panel) appear when their tools are first used.
3. Settings → AI shows one tool inventory with the groups, instead of a tab per surface.
4. Existing threads and sessions open in the merged view unchanged.

### Order of work

1. Engine: profile and `code` as a group, behind a flag, with chat still pinned to core.
2. Folder binding and its card.
3. Merged conversation view, then the single entry point.
4. Settings inventory, then remove the flag and the per-surface code paths.

## Open questions

- Does a merged session keep one title and one place in the sidebar, or do "chats" and "coding
  sessions" stay as filters over one list?
- Should the folder card offer "no folder, notes only" so `code` can be declined cleanly?
- Automations build their own tool list today. Do they move onto groups too, or stay as they are?

## Not in scope

- Unloading tools. It would re-write the cache and nothing needs it yet.
- Cache-reusing compaction. Tried in #279 and removed: on a tool-heavy session it sent about 14
  times more input than the clipped transcript and produced a worse summary.
