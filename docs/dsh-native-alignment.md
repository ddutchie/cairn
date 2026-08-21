# DSH-Native Alignment: Commands & Agent Persistence

Two divergences from the dsh north-star, what dsh does natively, and the
migration direction. Companion to `architecture-cordis.md`.

---

## 1. Commands

### dsh's model (`dsh-commands` → `ctx.commands`)
A **runtime command registry on the context**:
- `commands.register({ name, description, input, handler })` — plugins register
  via `ctx.inject(['commands'])` (e.g. `dsh-plan-mode` registers `/plan`,
  `dsh-permission-presets` registers `/permission`).
- `commands.execute(agent, line, images, signal)` — parse → lookup in the
  agent's scope view → append **`command/run`** to the session log → run
  handler → append **`command/done`**. Command invocations are durable session
  events.
- Hosts render a slash palette FROM the registry and execute through it; state
  changes flow back as ordinary session events (UIs observe via
  `session/event`, no live mirror).

### Cairn today (divergent)
- Renderer-side registry: `src/lib/slash-commands.ts` — built-in code constants
  (`/compact`, `/archive-chat`, prompt-template inserters) merged with
  user-defined rows in the SQLite `slash_commands` table.
- Intercepted in the chat/agent send paths by string-matching before send
  (`chat-panel/index.tsx:522`).
- Not visible to plugins; not logged as session events; duplicated per surface.

### Migration direction
1. Mount `dsh-commands` (`cordis:dsh:commands`) globally — it's already a dep.
2. Re-express Cairn's executable commands as registry entries (a small
   `cairn:commands` bridge registering handlers that call our existing loops:
   `/compact` → compactNow, etc.). Prompt-inserting "commands" are NOT commands
   in the dsh sense — they stay renderer-side template inserters.
3. Chat/coding inputs execute through `ctx.commands.execute(agent, line)` when
   the line parses as a command; fall through to normal followup otherwise.
4. The slash palette reads its entries from main (registry listing) instead of
   the hardcoded arrays; user-defined/community commands can register into the
   same runtime.

---

## 2. Agent persistence

### dsh's model
dsh separates **state** into exactly two durable layers:

| Layer | What | Where |
|---|---|---|
| **Session log** (append-only jsonl) | turns, tool calls/results (+ presentationMeta), `plan/mode`, `command/run`+`command/done`, `agent-preset/selected`, subagent lineage | `<root>/<encodedCwd>/<sessionId>/session.jsonl[.zstd]`; folds deterministically (`foldSurface`, `foldPlanMode`, projection units) |
| **Agent presets** (files) | named agent compositions: scoped cordis composition mounted once per preset under a standing scope; selection recorded per-session via `agent-preset/selected` | preset roots (`.system` shipped / `user` authored); id = directory |

There is **no agent database table**: an "agent" is (preset composition +
session log). Resume = `agents.resume(resumeSessionId)` replays the log;
everything else (plan mode, permission preset, selected preset, pending
intents) is recovered by folding events. UIs never store agent state — they
derive it.

### Cairn today (divergent)
- `pi_agent_sessions` row: `{id, project_id, task_title, task_id, cwd, mode,
  plan_note_id, status, spawned_at}` — host-side metadata duplicating things
  dsh already logs (`mode` ≙ `plan/mode` events, cwd is in the session header).
- `pi_agent_messages` legacy table (purged on launch, still exists).
- `chat_threads` similarly mirrors thread metadata that could fold from logs.
- Plan note id + status are genuinely Cairn-domain (notes/tasks linkage), but
  `mode` and parts of status overlap dsh state.

### Migration direction
Keep `pi_agent_sessions` ONLY for Cairn-domain columns (project/task/plan-note
linkage, display title) and treat everything the log already records as derived:
- `mode` → fold `plan/mode` from the session log (or read the plan projection).
- Drop writes of redundant fields; eventually slim the table to the Cairn-domain
  subset.
- Longer term: adopt dsh **agent presets** for "named coding agents" (our
  CodingAgent configs) instead of bespoke storage — a preset is a directory with
  a cordis composition; selecting one stamps the session log, so resume rebuilds
  the identical composition. That replaces our `coding_agents` store with
  something upstream-compatible.

---

## 3. Near-term actions

1. ✅ **DONE** — `dsh-commands` mounted globally (`cordis:dsh:commands`);
   `dsh-plan-mode` moved to the global context too (was per-turn in the coding
   stack) so its `/plan` command exists outside turns. The coding UI's plan
   toggle executes `/plan` | `/plan off` via `commands.execute` on a short-lived
   resumed agent → flips are logged as `command/run+done` + `plan/mode`
   (durable; resume folds them back). `plan/mode` session events are forwarded
   to the renderer as `pi-agent:mode-change`, so UI plan state derives from the
   authoritative log.
2. ✅ **DONE** — `compact` is registered in `ctx.commands`
   (`cairn-commands.ts`) with a shared implementation
   (`compactChatSession`); the `chat:compactThread` IPC is a thin wrapper over
   the same function, so there is exactly ONE compaction path with two entry
   points. A generic `cordis:executeCommand` IPC executes any registry command
   on a session's resumed agent (preload: `runtime.executeCommand`).
3. ✅ **DONE** — palettes merged + Settings → Commands shows a "Runtime
   commands" group (registry commands with an executable·logged badge).
   `getCommandsForScope` takes registry commands (`useRegistryCommands()` via
   `cordis:listCommands`) and merges them above built-ins/custom (precedence:
   custom > registry > built-in). Send intercepts in chat + agent panes execute
   any `/name` matching a registry command through `cordis:executeCommand`;
   pure prompt-inserters stay renderer-side. User-defined/community commands
   remain SQLite rows (prompt inserters) — deliberately: registry commands are
   EXECUTABLE agent actions, prompt-inserters are host UI templates; different
   kinds. A plugin can register executable commands via ctx.inject(['commands']).

## 4. Agent presets — future capability, not a migration

Cairn's `CodingAgent` store is a **CLI-binary launcher** config (binaryPath +
args for external CLIs like claude/aider) — a different concept from dsh's
agent presets (scoped cordis compositions mounted per preset, selection logged
via `agent-preset/selected`). The dsh-native future here is NEW functionality:
author named in-engine agent compositions as preset directories (model, tool
set, prompt sections) selectable per coding session. Tracked as a future
feature; no migration path from the CLI-launcher store.
   commands (`useRegistryCommands()` loads them via `cordis:listCommands`) and
   merges them above built-ins/custom (precedence: custom > registry >
   built-in). Send intercepts in chat + agent panes execute any `/name` that
   matches a registry command through `cordis:executeCommand`; pure
   prompt-inserters stay renderer-side. User-defined/community commands remain
   SQLite rows (prompt inserters) — a future registry re-home is optional.
