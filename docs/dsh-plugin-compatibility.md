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
| `skills` | `dsh-skill` SkillRegistry (mounted, `ctx.skills`) + `dsh-tool-skill` (owns the `skill` tool + `<available_skills>` catalog) | Cairn's SKILL.md provider feeds the registry |
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

## Client (UI) plugin packaging conformance

Service coverage (above) is only half the story: a **client** plugin also has to be
**packaged** the way dsh's client-module loader (`@deepseek-ai/dsh-client-modules`,
`scratch/dsh-repo/packages/client/modules/src/index.ts`) expects. dsh resolves by
exact string path from the **raw** `package.json` (no Node conditions resolver);
Cairn's installer + renderer loader are far more permissive. A package can therefore
**pass in Cairn yet be invalid for a real dsh shell**. Conformance checklist:

| Requirement | dsh loader | Cairn loader | Notes |
|---|---|---|---|
| `dsh.client.platform: "web"` | required (else silently skipped, index.ts:447) | ignored | — |
| `dsh.client.inject` = fiber edges into client graph | real edges; unresolved ⇒ fiber stalls | `KNOWN_UNPROVIDED` dsh-client-* ⇒ no-op | Cairn only provides `slots` shim |
| `exports["./client"]` present | required — else throw `declares dsh.client but exports no "./client" bundle` (index.ts:453) | required (else no `ui:` row) | — |
| `exports["./client"]` canonical target = **flat `./lib/client.js`** | resolves `{default}` incl. subdir, but off-convention is brittle | resolves `.default`/`.import`, checks file exists | see investigation §3 |
| client bundle body = `window.__ModuleLoader__.load({id, factory})`, `id` == package name | required (`system.ts` 78/107/119) | CommonJS fallback also accepted | dual-target bundle OK |
| `types` / all `exports.*.types` resolve to real files | not read at runtime, **but breaks `tsc`/`publint`/peer builds** → blocks the built artifact dsh serves | not read at all | **the trap** — dangling `./lib/types/**` |
| slot names target declared dsh slots | required (`slot "x" is not declared` throw) | resolved through dsh⇄Cairn alias map | — |

**Failure mode observed (`dsh-context-ring`, 2026-08-22):** package templated from a
tsdown-built dsh plugin but built with `tsc` (flat `.d.ts`), so every `types`
condition dangled at `./lib/types/**` and `./client` pointed at a `lib/client/index.js`
subdir. **Loads/renders in Cairn** (installer checks file existence; renderer accepts
`apply` and the plugin has a `registerChatFooter` fallback), **broken for dsh** at the
build/type + inject-closure layer. Full write-up:
**`docs/context-ring-plugin-load-investigation.md`**.

**Recommended Cairn hardening:** run a `publint`-style conformance check on install
and warn when `exports["./client"]` deviates from `lib/client.js`, so a malformed
community package surfaces the same error a dsh shell would — closing the
"works in Cairn, breaks in dsh" gap.

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
