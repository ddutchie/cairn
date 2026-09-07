# Investigation: `dsh-context-ring` plugin fails to load in dsh

> **Resolved record (2026-08-23).** The diagnosis and resolution stand, but branch names, version pins (`dsh-v0.1.1-rc.2`, Cordis 4.0.1), and file refs predate the current tree — read for rationale, not coordinates.

Investigation of the `feat/cordis-runtime` branch's most recent effort — extracting
the Context Ring into a standalone `dsh-context-ring` package and consuming it as a
first-class dsh community plugin. It loads and renders in **Cairn**, but does **not**
load correctly under the real **dsh web shell**. This report pins the root cause,
distinguishes "Cairn-path works" from "dsh-path broken", and lists the fixes.

- **Branch:** `feat/cordis-runtime` (`git merge-base main` = `d1c85101…`)
- **dsh reference:** `scratch/dsh-repo` @ `dsh-v0.1.1-rc.2` (matches installed `@deepseek-ai/*` `0.1.1-rc.2`, cordis `4.0.1`)
- **Package under test:** `node_modules/dsh-context-ring` (`github:ddutchie/dsh-context-ring`), `name: "dsh-context-ring"`, `version 0.1.0`

> **STATUS: RESOLVED (2026-08-23).** The plugin now loads **and applies cleanly in a
> real dsh web shell** (`deepseek-harness` @ `dsh-v0.1.1-rc.2`), verified headless via
> Playwright: it appears in `window.__DSH_BOOT__`, its bundle serves 200 at
> `/plugins/dsh-context-ring/client.js`, and there are **zero** `without inject` /
> `failed to apply loader entry` errors and no "Failed to load plugins" banner. It
> still loads in Cairn (dual-target). Fixes + reproduction in §7 below.

---

## TL;DR

The standalone package was authored by **copying the dsh client-plugin
`package.json` template** but shipping a build (`tsc`) whose **on-disk layout does
not match the paths the template declares**. dsh's client-module loader
(`@deepseek-ai/dsh-client-modules`) reads the raw `package.json` and resolves files
by exact string path — so the mismatches are fatal at the dsh boundary, while
Cairn's more lenient installer + dual `apply/activate` loader papers over them and
the plugin appears to "work" in Cairn.

Two classes of defect:

| # | Defect | Breaks dsh? | Breaks Cairn? |
|---|---|---|---|
| 1 | `exports.*.types` + top-level `types` all point at `./lib/types/**` — **that directory does not exist** (`.d.ts` files are flat at `lib/*.d.ts`) | No (runtime uses `default`) but **breaks every TS consumer** and fails `publint`/`tsc` on install | No (Cairn ignores types) |
| 2 | `exports["./client"]` → `./lib/client/index.js` (a **subdirectory**); dsh's canonical shape is a **flat** `./lib/client.js` | **Marginal / brittle** — see §3 | No (Cairn resolves `.default` and checks the file exists) |

The client bundle body itself is **correct** — it is a valid
`window.__ModuleLoader__.load({ id, factory })` registration and targets real dsh
slots. So this is a **packaging/manifest** problem, not a logic problem.

---

## 1. What dsh actually does to load a client plugin

Source: `scratch/dsh-repo/packages/client/modules/src/index.ts` (the ONLY host-side
client-plugin loader; `host/**`, `boot/**`, `bundle/**` just feed it entries).

1. Resolve `<pkg>/package.json` via `createRequire(ctx.baseUrl).resolve(...)` and
   **`JSON.parse` the raw file** (`resolveMeta`, index.ts:429–463). It does **not**
   use Node's conditional-exports resolver.
2. Read `pkg.dsh.client`, validate `platform`/`inject`/`immediately`
   (`parseDshClient`, index.ts:125–146). `platform !== 'web'` ⇒ silently skipped
   (index.ts:447).
3. Resolve the client file from `pkg.exports["./client"]` (`clientExportOf`,
   index.ts:148–159) — accepts a string or `{ default: string }`. If absent:
   `` client-modules: <pkg> declares dsh.client but exports no "./client" bundle `` (index.ts:453).
4. `clientPath = join(dirname(pkgPath), clientRel)` (index.ts:456). The file is
   read later (`initialBundleRevision`, index.ts:472–479); missing ⇒
   `MissingClientBundleError` → `` client bundles not found; run `pnpm run build` before launch `` (index.ts:82–97).
5. At serve time the file is streamed verbatim at `/plugins/<id>/client.js`
   (`serveBundle`, index.ts:529–565). The browser executes it, and it must call
   `window.__ModuleLoader__.load({ id, factory })` — the id **must match the graph
   row / package name** (`system.ts`: duplicate/absent-registration errors 78, 107,
   119–121).

Canonical reference package for comparison:
`scratch/dsh-repo/packages/client/ui-conversation/package.json` and
`packages/client/ui-theme/package.json`:

```jsonc
"main":  "lib/index.js",
"types": "lib/types/index.d.ts",              // NOTE: lib/types/…
"exports": {
  ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }  // NOTE: flat lib/client.js
},
"files": [ "lib/index.js", "lib/client.js", "lib/styles", "lib/types/**/*.d.ts" ]
```

dsh's own build (`packages/client/tsdown.client.ts`) emits, per package:
- `lib/index.js`, `lib/client.js` (flat, single-file CJS closure factories),
- `lib/types/**/*.d.ts` (declarations, in a `types/` subdir).

---

## 2. What `dsh-context-ring` actually ships

`node_modules/dsh-context-ring/package.json`:

```jsonc
"main":  "lib/index.js",
"types": "lib/types/index.d.ts",                 // ← file does NOT exist
"exports": {
  ".":           { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
  "./projection":{ "types": "./lib/types/projection.d.ts",   "default": "./lib/projection.js" },
  "./client":    { "types": "./lib/types/client/index.d.ts", "default": "./lib/client/index.js" }, // ← subdir
  "./types":     { "types": "./lib/types/types.d.ts",        "default": "./lib/types.js" }
},
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] } }
```

Actual on-disk layout (`find lib`):

```
lib/index.js            lib/index.d.ts          ← .d.ts is flat, NOT under lib/types/
lib/projection.js       lib/projection.d.ts
lib/pricing.js          lib/pricing.d.ts
lib/types.js            lib/types.d.ts
lib/client/index.js     lib/client/index.d.ts   ← client is a SUBDIR (index.js), not lib/client.js
lib/client/ContextRing.js …
```

So: **`lib/types/` does not exist at all**; every `types` condition is a dangling
pointer. And `./client` resolves to `lib/client/index.js`, not the canonical flat
`lib/client.js`.

The bundle body is fine — `lib/client/index.js` is a proper dsh registration:

```js
if (window.__ModuleLoader__?.load) {
  window.__ModuleLoader__.load({ id: "dsh-context-ring", factory: function (require) { … } });
}
// + a CommonJS fallback for Cairn / Node
```

and its `apply(ctx)` targets **real** dsh list slots:
`conversation.composer.dock` and `conversation.input.dock` (declared in
`scratch/dsh-repo/packages/client/ui-conversation/src/client/contract/slots.ts:205,214`),
using the real `ctx.slots.inject(name, () => ctx.slots.register({name,id,order}, C))`
API (matches `ui-conversation/src/client/apply.ts:137`).

---

## 3. Why it fails in dsh (root cause)

**Primary — the `types` layout mismatch (defect #1).** The package was templated
from a tsdown-built dsh package (which emits `lib/types/**`), but it is built with
plain `tsc` that emits `.d.ts` **next to** the `.js`. Result:

- `tsc`/`publint`/editor tooling resolving `dsh-context-ring` (or the peer that
  `inject`s it) hits missing `./lib/types/index.d.ts` → type resolution fails.
  Under dsh's monorepo (workspace TS project refs, `verbatimModuleSyntax`), a
  peer package that lists `@deepseek-ai/dsh-client-ui-conversation` alongside a
  broken sibling won't type-check/build, and dsh serves the **built** artifact —
  so a broken build blocks the plugin.
- The `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-conversation"]` edge only
  resolves if that package is present in the dsh install closure. In a bare
  community-plugin install it is a peer, not a dep — if absent, the inject edge
  never satisfies and the fiber stalls (informational inject; the row still loads
  but the slot registration in `apply` never runs against a live conversation UI).

**Secondary — the `./client` subdir shape (defect #2).** dsh *will* resolve
`./lib/client/index.js` (it honours `{ default }`), so this is not a hard throw by
itself. But it is off-convention and brittle:
- dsh's build purity gate and the `files` allow-list in canonical packages assume
  flat `lib/client.js`; the context-ring's `files: ["lib", …]` happens to include
  the subdir, so it publishes — but any tooling that assumes the canonical shape
  (bundle discovery, `dsh plugin` scaffolding, HMR path math in
  `system.ts`/`invariant.ts` that keys on `<id>/client`) is working against a
  non-standard path.
- `stripClientSuffix` (`manifest.ts`) normalises the specifier `<id>/client` ⇒
  `<id>`; the require graph expects the client entry to *be* the package's client
  half. A nested `index.js` still satisfies this, but it is the un-idiomatic path.

**Net:** the plugin is rejected/degraded at the **build/type + inject-closure**
layer before it ever renders in a real dsh shell — not at the JS-execution layer.

---

## 4. Why it "works" in Cairn (masking the defect)

Cairn does **not** exercise dsh's loader. Two independent lenient paths accept the
package as-is:

1. **Installer** — `electron/cordis/plugin-installer.ts:151–178` (`resolveEntries`)
   reads `exports["./client"].default` (`./lib/client/index.js`), checks the file
   **exists on disk**, and writes a `plugins.yml` row `{ ui: ./installed/<id>/lib/client/index.js }`.
   It never looks at `types`. Confirmed by
   `electron/cordis/plugin-installer.test.ts:127–135` which asserts exactly
   `lib/client/index.js`. (Note the installer's own header comment documents the
   *canonical* `./lib/client.js` — the test encodes the deviation.)
2. **Renderer loader** — `src/lib/plugin-ui/loader.ts` evaluates the CJS body and
   `api.ts:89–113` (`activateUIPlugin`) accepts **either** `activate(ui)` **or**
   `apply(ctx)`. The context-ring exports both; and its `apply()` has a
   `ctx.registerChatFooter(...)` fallback branch — which is a **Cairn** API
   (`CairnPluginUI.registerChatFooter`, `api.ts:33`), not a dsh one. So in Cairn it
   renders via `registerChatFooter`, never via the dsh `ctx.slots` path.

Additionally, its declared `inject` target `@deepseek-ai/dsh-client-ui-conversation`
is in Cairn's `KNOWN_UNPROVIDED` set (`platform-modules.ts:52–64`) — Cairn's ctx
shim only provides `slots` — so the dsh-injecting branch is a no-op in Cairn and the
footer fallback carries it. **Cairn's tolerance is exactly what hid the packaging
bug.**

---

## 5. Fixes (in the standalone package repo)

Ordered by leverage. All are in `github:ddutchie/dsh-context-ring`, not in Cairn.

1. **Match the canonical build layout.** Switch the build so declarations land in
   `lib/types/**` (dsh uses `tsdown`; a minimal fix is `tsc --declarationDir lib/types`
   + emit JS to `lib`), OR — simpler and equally valid — **point `types` at the
   real flat files**: `"./lib/index.d.ts"`, `"./lib/projection.d.ts"`,
   `"./lib/client/index.d.ts"`, `"./lib/types.d.ts"`. Either makes every `types`
   condition resolve. (Preferred: adopt tsdown so the whole package is byte-for-byte
   a canonical dsh client plugin.)
2. **Flatten `./client` to `./lib/client.js`** (canonical) — emit a single-file
   client bundle, or at minimum keep the subdir but be aware it is off-spec. If
   adopting tsdown per (1), this falls out for free.
3. **Verify the `inject` edge.** If the plugin only needs `slots`, declare
   `"inject": ["slots"]` (or drop `inject` and rely on the slot being present)
   rather than injecting the whole `@deepseek-ai/dsh-client-ui-conversation`
   package, which pulls a heavy peer into the closure.
4. **Add `publint` + `tsc --noEmit` to the package's CI** — either would have caught
   the dangling `types` paths before publish.

**Cairn-side (optional hardening):** have `resolveEntries` warn when
`exports["./client"]` deviates from `lib/client.js`, and have the installer run a
lightweight `publint`-style check so a malformed community package surfaces the same
error Cairn's users would hit in a real dsh shell — closing the "works in Cairn,
breaks in dsh" gap that masked this.

---

## 6. Broader gaps observed (context for the matrices)

- **Cairn is a permissive superset host.** It provides `ctx.slots` (shim) + a
  Cairn-native `activate(ui)` API and accepts both entry shapes, so a plugin can
  pass in Cairn while being invalid for dsh. There is currently **no
  dsh-conformance gate** on install.
- **Client-plugin resolution is stricter in dsh than Cairn.** dsh resolves by exact
  path from raw JSON; Cairn resolves `.default`/`.import` and only checks existence.
  Any packaging drift (types dir, client path, `files` list) is invisible in Cairn.
- **`inject` semantics differ.** dsh treats `dsh.client.inject` as real fiber edges
  into the client module graph; Cairn treats unprovided dsh-client modules as
  `KNOWN_UNPROVIDED` no-ops. A plugin relying on an injected conversation-UI service
  silently degrades in Cairn instead of stalling as it would in dsh.

See the updated **`docs/dsh-plugin-compatibility.md`** (§"Client (UI) plugin
packaging conformance") and **`docs/dsh-native-alignment.md`** (§"Client-plugin
packaging") for the matrix entries derived from this investigation.

---

## 7. Resolution — proven compatible in a real dsh web shell (2026-08-23)

Fixed in the plugin source repo (`../dsh-context-ring`, sibling of `cairn`) and
verified against the working `../deepseek-harness` (`dsh-v0.1.1-rc.2`, buildable web
shell). The defects in §2/§3 came from a **`tsc` build** whose layout didn't match the
templated `package.json`, plus **two Cordis runtime-contract gaps** that only surface
in a real dsh shell (Cairn's permissive host masked them).

### 7.1 Changes made

**Packaging → canonical dsh layout:**
- `tsconfig.build.json` — host build now emits declarations to `lib/types/**`
  (`declarationDir`), and **excludes `src/client/**`** (esbuild owns the client JS).
- **`tsconfig.client.json`** (new) — `emitDeclarationOnly` pass emitting
  `lib/types/client/**` declarations.
- `scripts/build-client.js` — writes the flat canonical **`lib/client.js`** (was
  `lib/client/index.js`).
- `package.json` — every `types`/`exports.*.types` now resolves to a real file under
  `lib/types/**`; `exports["./client"].default` → `./lib/client.js`; `files` narrowed
  to the real artifacts; `build` runs both tsc passes then esbuild.

**Cordis runtime contracts (the two errors seen live, in order):**
1. `cannot get property "slots" without inject` → the **client bundle must export
   `const inject = ["slots"]`** (`src/client/index.tsx`). Cordis inject-gates every
   service read on the client `ctx`; without declaring `slots`, `ctx.slots` throws.
   (Matches `packages/client/ui-goal/src/client/index.ts:41`, which exports
   `inject = ['slots', …]`.)
2. `cannot get property "registerChatFooter" without inject` → the Cairn-only
   `ctx.registerChatFooter` **fallback probe** hit the Cordis proxy, which throws on
   ANY undeclared property read (not just services). `apply()` was restructured so the
   dsh `slots` path **returns early** and the `registerChatFooter` (Cairn `ui`, a
   plain object) branch is only reached when there is no `slots` — the two hosts are
   now mutually exclusive and no bare property probe ever hits a Cordis ctx.

**Host half mountable as a cordis entry:** `src/index.ts` now also `export function
apply(ctx, config)` (mounts `ContextRingService`) so the package mounts as a Loader
entry — a client-only plugin still needs a host fiber so the client-modules loader can
discover its `dsh.client` and serve `./client`. (Pattern: `ui-goal`'s no-op host
`apply`, except ours provides the real host projection service too.)

The client bundle stays **dual-target**: it registers via
`window.__ModuleLoader__.load({ id: "dsh-context-ring", factory })` for dsh AND runs
its CommonJS fallback for Cairn/Node.

### 7.2 Reproduction (prove it loads in dsh)

```bash
# 1. Build the plugin to canonical layout
cd ../dsh-context-ring && npm run build          # emits lib/client.js + lib/types/**

# 2. Install it into a throwaway dsh web profile
export DSH_HOME=$(mktemp -d)
cd ../deepseek-harness
node apps/cli/lib/bin.js plugin --profile web add /abs/path/to/dsh-context-ring

# 3. Add a client roster row so the modules loader mounts + scans it:
#    $DSH_HOME/profiles/web/cordis.patch.yml
#      - insert:
#          - id: context-ring
#            name: 'dsh-context-ring'

# 4. Boot the web shell (an API key is only needed to chat, not to load plugins)
DEEPSEEK_API_KEY=sk-... node apps/cli/lib/bin.js web --port 7391 --no-open

# 5. Verify
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:7391/plugins/dsh-context-ring/client.js         # → 200
curl -s http://127.0.0.1:7391/ | grep -o 'dsh-context-ring'        # → in __DSH_BOOT__
```

Headless Playwright confirmed: `contextRingInBoot: true`, `failedBannerVisible:
false`, `anyPluginApplyErrors: []`.

### 7.3 Cairn-side follow-ups (unchanged recommendations, now higher value)

- **Update the installer test** — `electron/cordis/plugin-installer.test.ts` now
  asserts the canonical `lib/client.js` (done).
- **Add a conformance gate on install** (`publint`-style + warn when
  `exports["./client"]` ≠ `lib/client.js` or a `types` condition dangles) so Cairn
  surfaces the same error a dsh shell would — this is exactly what would have caught
  all three defects before a user hit them.
- **Consider validating the client `inject` export** so a plugin missing
  `inject: ["slots"]` is flagged in Cairn too, rather than silently working via the
  `registerChatFooter` fallback.
