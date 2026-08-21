# System Prompt & Session Build — Cairn vs DSH

How each side assembles the model's system prompt and the session it runs in,
what's shared, and what the `includeRuntimeContext` ("include context")
parameter actually does.

> Sources: `electron/lib/tools.ts` + `electron/cordis/{run-cordis-loop,cairn-plugins}.ts`
> (Cairn) and `scratch/dsh-repo/packages/core/{system-prompt,agent-loop}/src/*.ts`
> at `dsh-v0.1.1-rc.2` (dsh).

---

## 1. The big picture

dsh has a **three-part model input** per model step:

1. **Sections** — ordered prompt text (identity, persona, tool guidance, …).
2. **Contexts** — *dynamic* runtime context, materialised as a **durable
   `form:snapshot` user message** appended to session history each turn.
3. **Variables** — `{{variable}}` interpolation into section text.

Cairn uses **only #1 (sections).** It registers exactly one section
(`cairn:system:<id>`, order `-100`) with the text from `buildSystemPrompt()`.
It registers **no contexts** and **no variables** — so dsh's #2 and #3 are
effectively empty (a cleared snapshot, no interpolation).

| | Cairn | dsh default |
|---|---|---|
| Identity | `buildSystemPrompt` ("You are the Cairn AI assistant…") | `"You are an AI agent powered by DeepSeek Harness."` |
| Persona | appended as `## Personality: <name>` layer | `persona` config + scoped `deployment:persona` |
| Harness identity | **suppressed** (`includeHarnessIdentity:false`) | included (default true) |
| Dynamic contexts | **none registered** | dsh capability plugins register `systemPrompt.context()` |
| Variables | none | `{{variable}}` providers |
| Assembly | `renderPrompt` over sections | same `renderPrompt` |

---

## 2. What Cairn actually sends

`runCordisLoop` (chat) mounts `cairnSystemPromptPlugin` with
`{ systemText: withPersonality(buildSystemPrompt(req), req.personality) }`
(electron/cordis/run-cordis-loop.ts:603-605).

- `buildSystemPrompt` (tools.ts:167) returns a deliberately **lean ~110-token**
  prompt: identity + date + cross-cutting rules. Per-tool guidance lives in the
  **tools array**, not the prompt.
- `withPersonality` appends a delimited `## Personality: <name>` style layer.
- It is registered as a **single ordered section** on the global tree via
  `ctx.systemPrompt.section({ name, order: -100, text })` (cairn-plugins.ts:87).
  A low negative order puts it before the persona slot. dsh's own harness
  identity is suppressed because Cairn's section IS the identity.
- **No history transcript in the prompt.** Prior turns come from the persisted
  session (stable `SessionId`), not a "## Conversation so far" block.

### Session build (chat)
- One live `Agent` per thread, cached in `globalThis.__cairnChatAgents`.
- `agent.followup(createUserMessage({content, source:{kind:'user'}}))` — the
  new user message only; the session already holds prior turns.
- dsh appends a **runtime-context snapshot** as a `user/form:snapshot` message
  **when contexts are registered**. Cairn registers none → snapshot is
  empty/cleared, so nothing extra is injected.
- Both are appended in the same `turn/start → step/start` batch (the dsh-faithful
  "system/snapshot split").

### Session build (coding)
- Same: `mount(cairnSystemPromptPlugin, { systemText })`, then `systemText =
  systemPrompt + <available_skills>`. Runtime contexts also not registered.

---

## 3. What dsh's `includeRuntimeContext` ("include context") does

This is the parameter you asked about. It is `Config.includeRuntimeContext`
(system-prompt/src/index.ts:190, default **true**):

> *"Include dynamic runtime-context snapshots in model history (default true)."*

Mechanics:

- Capability plugins call `ctx.systemPrompt.context({ name, text, order })` to
  contribute a **dynamic context** (e.g. cwd, git branch, file tree, tool
  state). Each is measured/rendered per turn.
- With `includeRuntimeContext: true` (default), dsh turns those into a durable
  **`user/form:snapshot`** message in session history via
  `RuntimeContextProjection.project()` (agent-loop/src/runtime-context.ts:25):
  - It recomputes the full rendered context each turn; if the text changed, it
    appends a snapshot user message (`RuntimeContextProjection` tracks the last
    retained snapshot by event seq).
  - If nothing is registered, `current.length === 0` → it emits a **cleared**
    marker so stale context doesn't linger (when `retained` was set before).
- The **snapshot is intentionally excluded from tool-user-content** and from
  derive/replay as a "conversation" — it's ambient state, not dialogue
  (`session-replay.ts` drops `form:snapshot` turns).
- `includeRuntimeContext: false` calls `systemPrompt.suppressRuntimeContext()`
  so no snapshot is ever materialised.

### Practical effect in Cairn today
Because **no Cairn plugin registers a `systemPrompt.context()`**, the snapshot
is always empty/cleared → `includeRuntimeContext` (left at default **true**) has
**no observable effect** in Cairn. It only matters if we (or an installed
plugin) start contributing runtime context, or if a dsh capability plugin that
auto-contributes context is added.

---

## 4. So what would change if you flipped it?

- **Set `includeRuntimeContext: false`**: guarantees zero snapshot messages even
  if a future plugin adds context. Slightly leaner history, no risk of a stray
  ambient state block.
- **Leave it `true` + register contexts**: dsh starts inserting
  `user/form:snapshot` messages carrying e.g. cwd/git/workspace state — giving
  the model persistent awareness of the current project across turns without
  putting it in the system prompt. This is the mechanism a richer Cairn context
  (active project, open file, branch) would plug into.

Cairn currently registers **no contexts**, so the safe/recommended choice is
either default `true` (no-op today) or explicit `false` (defensive); there is
no behaviour to preserve either way.

---

## 5. If we later want dsh-style runtime context in Cairn

```ts
// somewhere in getContext, after loader.await():
const sp = ctx.get("systemPrompt")
sp.context({
  name: "cairn:workspace",
  order: 100,
  text: () => `Active workspace: ${workspaceName}\nProject: ${projectName}\nCwd: ${workspacePath}`,
})
```

That would make dsh materialise a snapshot each turn (respecting
`includeRuntimeContext`), and replay would skip it as `form:snapshot` — exactly
the behaviour dsh's own web shell has.

---

## 6. Comparison table

| Aspect | Cairn (`buildSystemPrompt`) | dsh (`SystemPrompt` + harness) |
|---|---|---|
| Identity text | "You are the Cairn AI assistant" | "You are an AI agent powered by DeepSeek Harness." |
| Harness identity included? | No (suppressed) | Yes (default) |
| Persona | `withPersonality` layer | `persona`/`deployment:persona` section |
| Tool guidance | in **tools array** (prompt is lean) | tool guidance sections (orders 100–199) |
| Skill list | `<available_skills>` XML appended in coding loop | contributed by skill plugins |
| History in prompt? | No — persisted session (stable SessionId) | No — session + snapshot |
| Runtime context (dynamic) | **not registered** → empty snapshot | registered by capability plugins → `form:snapshot` |
| `includeRuntimeContext` | default true (no-op, no contexts) | default true (active if contexts registered) |
| `{{variable}}` interpolation | none used | strict `{{variable}}` providers |
