# One agent session — plan and outcome

> Branch: `feat/staged-tools-default` · 2026-11-10 · Status: **decided — fork instead of a merged session type**
> Builds on `docs/plans/agent-engine-design.md` and on #279 (prompt-cache fixes).

## The question

Chat, coding and automations already run through one loop (`runTurn`). What differs per surface is
decided in `electron/ipc/engine-bridge.ts`: the tool list, the system prompt, the approval profile
and the working directory. The user picks the surface up front and could not move between them.

Could there be one kind of session that starts light and loads tools as the work calls for them?

## The constraint: prompt caching

Providers cache a request by its prefix, in the order tools → system prompt → messages. Any change
in that prefix re-writes the cache for everything after it. So nothing in the tool list or the
system prompt may change during a session; anything that changes travels with a prompt as
model-only context, and request-time pruning cuts from the start of the history in large steps.

## What was tried: staged tool loading (removed)

A session started with a base toolset and added groups through an `enable_tools` tool, append-only
so each enable cost one cache re-write. It worked live. It was removed because the numbers did not
justify it.

Coding toolset, built-in tools only (chars ÷ 4, this repository, 2026-11-09):

| | Tools | Tokens |
|---|---|---|
| Full list | 54 | 10,743 |
| Staged (core + code + `enable_tools`) | 43 | 9,841 |
| Extended group (deferred) | 12 | 1,064 |
| `skill` catalogue alone | 1 | 3,585 |

- The saving was about 900 tokens a request (8%); a caching provider bills cached input at roughly
  a tenth, so nearer 90 token-equivalents per step.
- One late enable re-wrote the cache for the whole conversation: with 20k tokens of history, about
  23k token-equivalents, or some 250 steps of that saving.
- The only case where staging paid was a chat that later turned on code tools. A merged session
  type built around that needed a merged conversation view, a folder-binding card, one approvals
  model and one system prompt. Fork gives the same move for far less.

## What shipped instead

### Fork

A fork is a new session whose log starts as a copy of another session's conversation
(`agent/session/fork.ts`, IPC `session:fork`, the Fork button in the action row of the last reply).

| From | To | Allowed | Notes |
|---|---|---|---|
| Chat | Chat | yes | Same tools and prompt, so a content-keyed cache is reused straight away. |
| Chat | Coding | yes | Runs in the project's code folder (`projects.code_directory`); offered only when one is set. The first request re-reads the history once, because the tool list and system prompt differ. |
| Coding | Coding | yes | Same folder as the source. |
| Coding | Chat | **no** | The history is full of file and shell tool calls a chat cannot make; some providers reject that. Refused in the IPC handler, not only hidden in the UI. |

- The fork is a top-level session. Its log header records `forkedFrom`; it does not use `parentId`,
  which marks a subagent.
- Left behind: the goal, reminders, and approval rules when the fork is a different kind of
  session. Subagent logs are not copied.
- A session cannot be forked mid-turn, when a copy could end on a tool call with no result.
- Forking is from the end of the session only.

### The skill list is context, not a tool definition

The catalogue was a third of the coding tool tokens here (24 skills, about 3,500 tokens), in a tool
description that changed whenever a skill file did.

- The `skill` tool has a fixed description. Called with no name it returns the list; skills are
  read at call time, so one added during a session is found.
- A session gets the list once as standing context. It is sent again only after compaction or when
  the list changes, and then it is appended, so the cached prefix is untouched.
- Descriptions go out in full, because they are what makes a skill trigger. Only when the whole
  list is over 2% of the model's context window is every description clipped to the same length.
  That matches Claude Code and Codex, which keep the list out of the tool and cap it with a budget
  of about that size; OpenCode keeps it in the tool description, as Cairn did.
- Subagents carry the `skill` tool but not the session's context, so they call it with no name first.

## Open

- Fork from a chosen message, not only from the end.
- A live check that skills trigger as often from context as they did from the tool description.
- Subagents could be given the skill list in their brief.
- Coding → chat by way of a summary, if it turns out to be wanted.

## Not in scope

- Unloading or loading tools mid-session. See above.
- Cache-reusing compaction. Tried in #279 and removed: on a tool-heavy session it sent about 14
  times more input than the clipped transcript and produced a worse summary.
