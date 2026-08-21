# DSH Plugin Compatibility Matrix

At dsh `0.1.1-rc.2` — which Cordis services a plugin can `inject`/`get`, which
Cairn provides, and whether a "most plugins work" claim holds. This is the
cross-check against `scratch/dsh-repo` (checked out at `dsh-v0.1.1-rc.2`, matching
the installed `@deepseek-ai/*` versions).

> Derivation: all `super(ctx, "<svc>")` (services) and `inject: ["<svc>"]`
> (plugin seams) across `scratch/dsh-repo/packages/**`. Test-fixture services
> (`collidingWire`, `missingMethod`, `noBinding`, `firstShared`, …) are excluded
> as noise (they only exist in Cordis unit tests).

## Legend

- **✅ Cairn provides** — mounted on the shared context (or provided by Cairn's
  own wiring). Plugins injecting these activate.
- **🔶 Installable dep** — an installed `@deepseek-ai/dsh-*` package provides it;
  we could mount it on demand. Not mounted today unless noted.
- **🚫 Shell-only / web-host** — a dsh web-shell or host concern Cairn (an
  Electron agent) neither needs nor provides. A plugin injecting one stalls
  (inject-gating) and logs; the rest of the plugin is unaffected.

## Core agent services (✅ provided)

| Service | Source |
|---|---|
| `tools` | `ctx.tools.register/get` (Cairn bridged tools + plugin tools) |
| `skills` | `dsh-skill` SkillRegistry (mounted) + Cairn SKILL.md provider |
| `fs` | chat-chain `SandboxedFileSystem` (lazy, dev-gated) |
| `sessions` | `dsh-session` registry |
| `agents` / `agentLoop` | `dsh-agent` + `dsh-agent-loop` |
| `llm` | `dsh-llm` |
| `systemPrompt` | `dsh-system-prompt` (persona suppressed) |
| `approval` | `dsh-user-approval` |
| `userQuestions` | `dsh-user-questions` |
| `attachments` | `cairn:attachment-store` (readImageRequest) |
| `compaction` / `tokenMeter` | dsh compaction + token-meter |
| `sessionPersistence` | JsonlSessionPersistence |
| `sandbox` / `sandboxPolicy` | coding + chat fs chains (ownership trio) |
| `subagents` | `dsh-subagent` stack |
| `invariants` | **added** — `dsh-invariants` InvariantRegistry (mounted) |
| `loader` | `cordis-plugin-loader` |
| `slots` | Cairn's ctx shim (`dsh-client-ctx.ts`) for UI plugins |
| `timer` | `cordis-plugin-timer` (installed) |

## Installable deps (🔶 — mount on demand if a family needs them)

| Service | Installable package | Notes |
|---|---|---|
| `commands` | `dsh-commands` | CLI command registry |
| `scope` | `dsh-scope` | scoped context layering |
| `shellEnv` / `subprocess` | `dsh-shell-env` / `dsh-subprocess` | already in the coding stack |
| `planMode` | `dsh-plan-mode` | already in the coding stack |
| `permissionPresets` | `dsh-permission-presets` | dep present, not mounted |
| `sessionProjection*` | `dsh-session-projection` | projection cache |
| `codeRuntime` | `dsh-code-runtime` | code exec transport |
| `spillStore` | `dsh-spill` | oversized spill |
| `authorization` | `dsh-authorization` | permission checks |

## Shell-only / web-host (🚫 not provided — plugins using these degrade gracefully)

`web`, `webServer`, `remote`, `connection`, `apiProxy`, `conversation*`,
`commandUi`, `commands` (UI), `inputTriggers`, `messageFeedback`, `goals`,
`lsp`, `e2b`, `terminals`, `shell`, `storage`, `workspaceRegistry`,
`sessionTitle`, `workflowEngine`, `agentPresets`, `agentTeams`, `credentials`,
`settings*`, `sessionQuery`, `fileReferences`, `directoryPicker`, `typert*`,
`clientModules`, `codeRuntime`, `dynamicCordisRunner`, `cordisInspect`,
`pluginInventory`, `modelDirectories`.

These are web-shell/dsh-host features (an Electron agent doesn't have a browser
shell, a settings UI, or a remote client). They are expected gaps, not regressions.

## Verdict

- **Most agent-oriented plugins work unmodified.** The core user/agent seams
  (`tools`, `skills`, `fs`, `sessions`, `agents`, `llm`, `approval`,
  `userQuestions`, `attachments`, `invariants`) are all provided. A real
  backend plugin like **dsh-visualize** loads and its tool executes end-to-end.
- **The biggest real gap is the host UI/control plane** (`web`, `conversation`,
  `settings`, `commands` UI, `credentials`) — but plugin authors split
  backend/browser halves (`dsh.bundle.patch` for the agent, `client` for the
  web shell), and the browser half is opt-in via `ui:`. A plugin that only needs
  agent capabilities works; one that also surfaces a web-shell panel needs that
  shell, which isn't Cairn.
- **Mount-on-demand is cheap** for the 🔶 family: each is just another
  `cordis:` builtin + `ENTRY_LIST` row once we add the package as a dependency.

## Changes made from this matrix

- ✅ **Mounted `ctx.invariants`** (`dsh-invariants`, already a dependency) —
  companion plugins that `inject: ["invariants"]` now activate instead of
  stalling. Verified: `getContext()` exposes `invariants` with a working
  `register`.

## How to re-derive after a dsh bump

```bash
cd scratch/dsh-repo && git fetch --tags && git checkout dsh-v<NEW>
# services:
grep -rhoE "super\(ctx, *'[a-zA-Z][a-zA-Z0-9]*'\)" packages --include="*.ts" | sed -E "s/.*'([a-zA-Z0-9]+)'.*/\1/" | sort -u
# inject seams:
grep -rhoE "inject *: *\[[^]]*\]|inject *= *\[[^]]*\]|static inject *= *\[[^]]*\]" packages --include="*.ts" | grep -oE "'[a-zA-Z][a-zA-Z0-9]*'" | tr -d "'" | sort -u
```
