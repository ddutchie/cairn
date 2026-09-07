# dsh Upgrade Guide — Universal Playbook

> How to evaluate and land a new `deepseek-harness` (dsh) release on Cairn's **Cordis** runtime.  
> Companion to `architecture-cordis.md` §8 (bump checklist) and `dsh-plugin-compatibility.md` (service coverage).  
> Each release is `developer preview` and **will** contain breaking changes — treat every bump as a migration, not a version bump.

---

## 1  Where to look

| Source | What it tells you | Command / URL |
|---|---|---|
| **npm dist-tags** | Coherent train to bump to (`next` is Cairn's line, `latest` is often a stale `0.0.1-rc.1`, `alpha` is the bleeding edge) | `npm view @deepseek-ai/dsh-agent dist-tags --json` + `npm view @deepseek-ai/cordis dist-tags --json` |
| **npm version list** | Full publish history, publish dates | `npm view @deepseek-ai/dsh-agent versions --json` |
| **tarball diff** | Ground truth for API drift (README, `lib/`, `package.json` peers). `package.json` alone lies about the blast radius | `npm pack @deepseek-ai/<pkg>@<old> && npm pack @deepseek-ai/<pkg>@<new> && diff -r` — see §3 recipe |
| **GitHub releases** | Tag → commit, release notes, breaking-callout | `https://github.com/deepseek-ai/deepseek-harness/releases` |
| **Upstream package README** | Per-package contract, new config, known limits | `lib/README.md` inside the tarball or `scratch/dsh-repo/packages/<pkg>/README.md` |
| **Changelog mirrors** | Curated, integrators-focused notes (sometimes ahead of npm) | `https://dsharness.org/changelog`, `https://deepseek-harness.github.io/deepseek-harness/` |
| **Discussions** | Breaking-change callouts that didn't make release notes (e.g. `ApiProxy` removal, `CallId→ToolCallId`) | `https://github.com/deepseek-ai/deepseek-harness/discussions` |

No single source is sufficient. `npm view` tells you **what** shipped; tarball diff tells you **how** it broke.

---

## 2  Pre-flight: decide the train

1. Resolve the **target tag**:
   ```bash
   npm view @deepseek-ai/dsh-agent dist-tags --json
   npm view @deepseek-ai/cordis dist-tags --json
   # Cairn tracks `next` (≈ rc line). Only take `alpha` behind a feature branch.
   ```
2. Check `apps/cli/package.json` version at the GitHub tag vs npm `version` — a tag without a publish (`0.1.2-alpha.1`) means **source-only**, not installable via `npm pack` tarball overrides. Prefer an npm-published alpha/rc (e.g. `0.1.2-alpha.3` is published; `alpha.1` was not).
3. List **all 39+ `@deepseek-ai/dsh-*` deps** in Cairn's `package.json`. They must move together — a partial tree deadlocks peer resolution (`E_RESOLVE`). `cordis` version must match its `cordis-plugin-loader/include` peers.
4. Diff the **new `peerDependencies`** across a sample of 5 packages (`dsh-agent`, `dsh-session`, `dsh-subagent`, `dsh-agent-loop`, `dsh-tools`). New peers like `dsh-brand`, `dsh-util-values`, `dsh-session-query`, `dsh-session-projection`, `zod` are not optional — the plugin will fail closed without them.

---

## 3  Tarball diff recipe (the only reliable drift detector)

```bash
# 1. Pack old vs new for each package you mount (or at least the 9 we mount directly).
# NOTE: never put dead packages in this loop — e.g. dsh-tool-subagent-report
# was unpublished past 0.1.2-alpha.3, so packing it aborts the loop (and its
# tarball is missing for extraction). Check `npm view ... versions` first.
for pkg in dsh-agent dsh-agent-loop dsh-session dsh-subagent dsh-tool-subagent \
           dsh-tool-subagent-control dsh-schedule dsh-tools cordis; do
  npm pack @deepseek-ai/$pkg@<OLD> --pack-destination /tmp/dsh-compare  # old
  npm pack @deepseek-ai/$pkg@<NEW> --pack-destination /tmp/dsh-compare  # new
done

# 2. Extract side-by-side
for pkg in dsh-tool-subagent dsh-subagent dsh-agent-loop dsh-session dsh-schedule; do
  rm -rf /tmp/dsh-compare/$pkg-old /tmp/dsh-compare/$pkg-new
  mkdir -p /tmp/dsh-compare/$pkg-old /tmp/dsh-compare/$pkg-new
  tar -xzf /tmp/dsh-compare/deepseek-ai-$pkg-<OLD>.tgz -C /tmp/dsh-compare/$pkg-old --strip-components=1
  tar -xzf /tmp/dsh-compare/deepseek-ai-$pkg-<NEW>.tgz -C /tmp/dsh-compare/$pkg-new --strip-components=1
done

# 3. Diffs that matter
diff -u /tmp/dsh-compare/dsh-tool-subagent-old/package.json /tmp/dsh-compare/dsh-tool-subagent-new/package.json
diff -rq /tmp/dsh-compare/dsh-tool-subagent-old/lib /tmp/dsh-compare/dsh-tool-subagent-new/lib
diff -u /tmp/dsh-compare/dsh-tool-subagent-old/lib/types/index.d.ts /tmp/dsh-compare/dsh-tool-subagent-new/lib/types/index.d.ts | head -n 300
# Repeat for dsh-subagent, dsh-agent-loop, dsh-session, dsh-schedule, cordis
```

What to read in the diff:

* `package.json` `peerDependencies`/`dependencies` — new `zod`, `dsh-brand`, `dsh-util-*`, `dsh-session-query` peers.
* `lib/types/*.d.ts` — new config keys (`modelSelectionSettings`, `agentReasoningEffort`), new error codes, renamed `CallId→ToolCallId`, `SessionId` now via `brandString`.
* `lib/index.js` — new `mount()` registrations, new error throws (`SUBAGENT_CONTROL_*_UNAVAILABLE`), `SessionId()` → `brandString()` migration.
* `README.md` — new sections (`Schedule overlay`, `Model selection`, `code-mode → PTC mode`) + `Known Limitations` retention.

---

## 4  Taxonomy of breakage (check every bump)

| Bucket | Signal in diff | Cairn impact |
|---|---|---|
| **Branded strings** | `SessionId(x)` → `brandString(x)` | Every `SessionId()` call in `run-cordis-coding.ts`, `session-runtime.ts`, `cordis-context.ts` |
| **Branded seq / event-read API** | `SessionEvent.seq: number` → `SessionSeq`; `session.events` removed in favour of `seq`/`eventAt()`/`snapshotEvents()`/`ownEvents()`; header `seedLength` → `isSeeded` + `inheritedEventCount` | `chat-session-runner.ts`, `cairn-plugins.ts`, `session-turn.ts` + replay tests — runtime-safe (still numbers) but `tsc` needs `SessionSeq()` wrapping |
| **Removed packages** | e.g. `dsh-tool-subagent-report` unpublished past `alpha.3` (bidirectional `send_message` replaces one-way `report`) | Drop from `package.json`; check `src/generated/licenses.json` for stale refs; confirm no imports remain |
| **Peer set change** | new `dsh-brand` / `dsh-util-values` / `dsh-session-query` / `zod` | `package.json` + `package-lock.json` must include them; missing peer → `Cannot find module` at mount |
| **Descriptor/log version** | `SUBAGENT_DESCRIPTOR_VERSION 2 → 3` / `SESSION_FORMAT_VERSION` | Cold subagent resume, replay, and listing — old sessions still read (no migration) but new writes use v3 |
| **Service rename / removal** | `dsh-client-runtime → dsh-client-modules`, `ApiProxy` deleted | `cordis-context.ts` `B` map and `builtin → service key` table |
| **Inject gating** | new `inject: ["sessionProjections","sessionQuery"]` | `mountCodingStack` / `mountFsChain` idempotence; add mounts if we adopt |
| **Tool contract** | new `list_subagent_models` tool, `provider/model/reasoning_effort` on `subagent` | No opt-out break if `modelSelectionSettings:false`; opt-in needs a `Host` setting + projection |
| **Cordis bump** | `cordis 4.0.1 → 4.0.2` + `cordis-plugin-loader 1.0.2→1.0.3` | Usually transparent, but verify `loader.builtins` shape |

---

## 5  Mechanical bump (do this on a feature branch)

1. **Update `package.json`** — bump **every** `@deepseek-ai/dsh-*` + `cordis` to the target tag in one commit (never `npm update` one-by-one). Add any newly-required peer (e.g. `@deepseek-ai/dsh-brand`, `zod`) as a direct dep if we import it; otherwise let peer resolution supply it.
2. **Clean peer deadlocks** — partial trees deadlock. Resolve by:
   ```bash
   rm -rf node_modules/@deepseek-ai/dsh-* node_modules/@deepseek-ai/cordis
   # Strip stale keys from package-lock deterministically (don't hand-edit):
   node -e "let p=require('./package-lock.json');for(let k of Object.keys(p.packages||{}))if(k.includes('@deepseek-ai/dsh-')||k.includes('@deepseek-ai/cordis'))delete p.packages[k];for(let k of Object.keys(p.dependencies||{}))if(k.includes('@deepseek-ai/dsh-')||k==='@deepseek-ai/cordis')delete p.dependencies[k];require('fs').writeFileSync('package-lock.json',JSON.stringify(p,null,2))"
   npm install
   ```
3. **Single-copy check:**
   ```bash
   find node_modules -path '*cordis/package.json' | wc -l   # must be 1
   grep -r '0\.1\.1-rc\.2' node_modules/@deepseek-ai/*/package.json | grep '"version"' | sort -u  # no stragglers
   ```
4. `npm run compile` — fix API breaks (rename imports, adjust `SessionId`→`brandString`, add new required config).
5. `npm run type-check:all` — upstream type drift often requires no Cairn code change; fix where `tsc` complains (usually new required fields on `Config` schemas).
6. Update **fixtures** that encode retired behavior (see `architecture-cordis.md` §8.1 table).

---

## 6  Wiring new capabilities (adopt vs defer)

Most bumps ship **opt-in capabilities** — the stack still boots without them, but functionality degrades to the old path. Decide per capability:

| Capability | Enable condition | If deferred | If adopted — wiring |
|---|---|---|---|
| `dsh-schedule` (durable reminders, `schedule_create/list/delete`) | Mount `dsh-schedule` + `dsh-session-projection` + optionally `dsh-time-context`; needs a **patch overlay** (`dsh web --patch .../schedule/cordis.yml`) in upstream. Sessions created before the overlay have no reminder tools. | No breakage — just absent `schedule:*` tools. | Add `schedule` to `ENTRY_LIST` behind a Cairn Setting toggle. The schedule projection checkpoints `{seedLength,active,seenIds}` — seed-aware. Verify flush-barrier semantics (`ctx.sessions.flush` before decisions). |
| `subagent model selection` (`provider/model/reasoning_effort` on `subagent`) | `tool-subagent.modelSelectionSettings:true` + backend `agentOptions` + `SubagentModelSelectionConfig` Host setting + `dsh-session-query` | Old fixed-route path still works. | Add `model-selection-settings` service mount + per-session policy projection inheritance. Verify preflight via `llm.resolveCallConfig`. Ship fork tools without selection (they inherit parent prefix). |
| Subagent image forwarding | Automatic — `contentHasImage` check + `MODEL_DOES_NOT_SUPPORT_IMAGES` error | N/A | Wire `admitPromptContent` already used in `buildCordisUserContent`; verify image-capable model routing. |
| `cordis` 4.0.2 (`cosmokix` bump) | Transparent | — | Verify `loader.builtins` table; no API change expected. |
| `code-mode → PTC mode` rename | String rename in session vocab | Persisted `code-mode` kept as alias — no migration needed | Search for literal `code-mode` strings in Cairn; keep alias tolerant. |

**Rule of thumb:** ship the mechanical bump first (no new mounts), then enable one capability per follow-up PR. Never enable two capabilities and the version bump in one PR — you want the bisect to be meaningful.

---

## 7  Testing matrix

| Layer | Command | What it proves |
|---|---|---|
| Static | `npm run type-check:all` | API drift closed |
| Bundle | `npm run compile` | esbuild `ctx` string imports + native binding fan-out intact |
| Unit | `npx vitest run electron/cordis/*.test.ts` | Mount wiring, mock-injected seams |
| Live (needs bridge) | `CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local npx vitest run electron/cordis/*.live.test.ts --reporter=verbose` | Model bridge (`http://localhost:3042/v1`), attachment round-trip, tool execution, session resume (requires Rork bridge) |
| Electron QA | `npm run compile && npx playwright test -c playwright.electron.config.ts` | Real `dist-electron/main.js` + real IPC (`session:*`) end-to-end (gated on `CORDIS_LIVE=1`) |
| Manual | Chat image attach + coding `run_in_background` `subagent` + `/compact` + plan toggle | Regression of the "brokenビ" paths (see below) |

**Known flakes:** HITL `autoApprove:false` tests are model-choice-sensitive — run solo when debugging.

---

## 8  When to land

* **RC line (`next` tag — Cairn's default train):** land promptly — this is the supported upgrade path, usually 30-80 commits, low-risk diff. Cherry-pick across `package.json` only.
* **Alpha line (`alpha` tag — e.g. `0.1.2-alpha.3`):** land behind a feature branch, gated by the testing matrix above. Expect 800-1100 commits, new mandatory peers, and doc rewrites. Value-proposition must justify the churn — otherwise wait for the next RC that pulls alpha changes forward.

---

## 9  Changelog & release note handling

* Cairn's own `changelogs/vX.Y.Z.md` documents **user-visible** impact, not the full dsh diff. One line per newly-exposed capability ("Schedule reminders (dsh-schedule) now available as an opt-in overlay") is enough.
* Update `docs/architecture-cordis.md` §8.1 `Known historical breakage points` table whenever a bump introduces a new row (e.g. `brandString`, `sessionQuery`).
* Update `docs/dsh-plugin-compatibility.md` service-coverage matrix when mounting any new service.

---

## 10  Emergency rollback

Every bump commit should be revertable with one `git revert`. The `package-lock.json` strip-and-reinstall trick above is also the rollback recipe (revert `package.json`, strip, reinstall). Session logs written at the new descriptor/session version still read on the old runtime **until** the version is bumped past the `SESSION_FORMAT_VERSION` guard — currently pinned at `0` (no migration, incompatible logs rejected). If `SESSION_FORMAT_VERSION` ever moves, rolling back requires discarding sessions created on the newer version.
