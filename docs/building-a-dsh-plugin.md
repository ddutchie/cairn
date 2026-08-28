# Building a DSH / Cordis plugin (field guide)

Everything learned building two real community plugins — **`dsh-context-ring`**
(the context/usage ring) and **`dsh-usage-tracker`** (durable usage history) —
against DeepSeek Harness `dsh-v0.1.1-rc.2`. This is the "what actually works /
what bites you" guide, distinct from the harness's own tutorial
(`../deepseek-harness/docs/user/develop/basic/index.md`, which only covers
backend/tool plugins).

Reference repos on disk:
- Harness (buildable, run web): `../deepseek-harness` (tag `dsh-v0.1.1-rc.2`)
- Working plugin to copy from: `../dsh-context-ring`
- Durable+Remote example (WIP): `../dsh-usage-tracker`
- Canonical dsh feature plugins: `deepseek-harness/packages/client/*`, `packages/feedback/message-feedback` (durable + Remote)

---

## 0. Mental model

A dsh plugin has up to **three halves**, each an optional export/entry:

| Half | Where it runs | Entry | Purpose |
|---|---|---|---|
| **Host plugin** | electron/node (agent process) | `.` (`export apply(ctx)`) | services, tools, session projections, storage, Remotes |
| **Client plugin** | the web shell (browser) | `./client` (a `__ModuleLoader__` bundle) | UI: slots, panels, widgets |
| **Plain React** | any React host (Cairn embeds it) | `./react` (normal ESM) | importable components, no plugin runtime |

The **host** and **client** halves communicate ONLY through dsh seams:
session **projections** (host→client, per-session), **Remotes** (host→client
RPC, cross-session), and **events**. There is no shared memory.

---

## 1. Package layout (copy `dsh-context-ring`)

```
package.json      # exports map + dsh.client manifest + files (SHIP lib/**)
tsconfig.json     # base: outDir ./lib, jsx react-jsx, module NodeNext
tsconfig.build.json   # host: declarationDir ./lib/types, EXCLUDE src/client + src/react
tsconfig.client.json  # client+react: emits JS to lib, declarations to lib/types
scripts/build-client.js  # esbuild → lib/client.js (the __ModuleLoader__ bundle)
src/index.ts      # host: export apply(ctx); named exports
src/client/index.tsx  # client: export inject, apply(ctx), activate(ui), default
src/react.ts      # plain-ESM re-export of components
```

### package.json essentials

```jsonc
{
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./react":  { "types": "./lib/types/react.d.ts",        "default": "./lib/react.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/**/*.js", "lib/types/**/*.d.ts", "README.md", "README.zh.md", "LICENSE"],
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] } },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && tsc -p tsconfig.client.json && node scripts/build-client.js",
    "prepublishOnly": "npm run build"
  }
}
```

### HARD RULES (each cost hours the first time)

1. **Commit `lib/`** (do NOT gitignore it). Cairn's Settings installer and the
   harness both fetch a **github tarball and extract it — they do NOT run
   `npm install`**, so there's no build step. Prebuilt `lib/` must be in the repo.
   Use **`prepublishOnly`**, NOT `prepare` — a github install has no
   devDeps/network, so a `prepare` build fails; the committed `lib/` is used as-is.
2. **`files` must include every emitted JS** (`lib/**/*.js`). A missing module
   (e.g. a helper the host `index.js` imports) crashes the harness at load with
   `ERR_MODULE_NOT_FOUND`.
3. **Canonical layout**: declarations under `lib/types/**` (not flat next to JS);
   `./client` is a **flat** `lib/client.js` (the esbuild `__ModuleLoader__`
   bundle), not `lib/client/index.js`. dsh reads the raw package.json by exact
   path — drift = silent breakage. (This was the whole first context-ring bug.)
4. **Bilingual READMEs** like other plugins: `README.md` (with an
   `English | [中文](README.zh.md)` switcher) + `README.zh.md`.

### Building outside the workspace
Peer deps (`@deepseek-ai/cordis`, `dsh-session`, `dsh-storage-domain`,
`dsh-typert-protocol`, `@deepseek-ai/schemastery`) are workspace/vendored — not
plainly installable. To type-check the build, **copy their built dirs from the
harness** into your `node_modules/@deepseek-ai/`:
```sh
cp -R ../deepseek-harness/packages/typert/protocol      node_modules/@deepseek-ai/dsh-typert-protocol
cp -R ../deepseek-harness/packages/storage/storage-domain node_modules/@deepseek-ai/dsh-storage-domain
# + cordis, dsh-session from ../dsh-context-ring/node_modules
```
They're runtime-provided by the host, so they're **optional peers**; only needed
for `tsc`.

---

## 2. The host half (`src/index.ts`)

```ts
import { Service, type Context } from "@deepseek-ai/cordis";

export class MyService extends Service {
  static readonly provide = "myThing";
  static readonly inject = ["someService"];   // gates activation until available
  constructor(ctx: Context, config = {}) {
    super(ctx, "myThing");
    ctx.on("session/event", (session, event) => { /* fold */ });
  }
  protected async [Service.init]() { /* async setup (open storage) */ }
}
export function apply(ctx: Context, config = {}): void { ctx.plugin(MyService, config); }
```

- A **client-only** plugin still needs a host `apply` (even a no-op) so the
  package mounts as a Loader entry and the client-modules loader discovers its
  `dsh.client` block. (See `ui-goal`: `export function apply(): void {}`.)
- **`inject` runs on the service's fiber scope** — register projections / call
  `ctx.inject([...])` **inside the constructor**, NOT from the top-level `apply`
  (that fiber-scope mismatch silently no-ops).

---

## 3. Session projections (host→client, per-session)

The way a client widget reads live per-session host data (`useProjection(key)`).

```ts
ctx.inject(["sessionProjections"], (c) => {
  c.sessionProjections.register(myProjectionDefinition);
});
```

A `ProjectionDefinition` = `{ key, stateVersion, stateSchema, init, apply, wire }`.

- **`apply(state, event)` MUST be pure**: never mutate `state`; return the SAME
  reference when nothing changed (`Object.is` → zero downstream work). An impure
  or throwing `apply` runs in the session-event dispatch path and can **break the
  turn / message sending**. Wrap the fold in try/catch as a safety net.
- The runtime delivers any registered projection with a `wire` to the client —
  the key does NOT need to be in the compile-time `SessionProjectionMap`; a
  permissive `{ parse: v => v }` schema shim works (no zod dep needed).
- Real event shapes (dsh 0.1.1-rc.2): model at `request/header.data.header.config`,
  usage at `assistant/message.data.usage` and `assistant/chunk.data.chunk.usage`.

---

## 4. The client half (`src/client/index.tsx`)

```ts
export const inject = ["slots"];          // Cordis inject-gates ctx.slots etc.
export function apply(ctx: any): void {
  if (ctx?.slots?.inject) {               // DSH web shell path
    ctx.slots.inject("conversation.view", () => ctx.slots.register(
      { name: "conversation.view", id: "mine", order: 30, label: () => "Mine" },
      MyComponent));
    return;
  }
  if (typeof ctx?.registerChatFooter === "function") { /* Cairn ui facade */ }
}
export function activate(ui: any) { apply(ui); }   // Cairn calls activate(ui)
export default { inject, apply, activate };
```

### Client rules that bite

1. **Inject-gating is on EVERY property read** of the Cordis `ctx` proxy — not
   just services. Reading `ctx.slots` / `ctx.remote` / `ctx.remote.usage`
   throws `cannot get property "X" without inject` unless `X` is in `inject`.
   BUT never inject a namespace **you mount yourself** (deadlock — see §5).
2. **Slot scope decides what props you get.** A `conversation.view` /
   `conversation.composer.dock` (scope `session`) component receives the
   session kit incl. **`useProjection`**. A `settings.section` (scope `root`)
   does **NOT** get `useProjection` — it needs an `inject` face or a Remote.
3. **No Tailwind in the shell.** Use inline styles. Utility classes are inert →
   popovers render in normal flow ("pops open" instead of floating).
4. **Theme via CSS vars** so light/dark follows the host: chain
   `var(--dsw-alias-label-primary, var(--text-primary, #fallback))`
   (DSH `--dsw-alias-*` tokens, then Cairn `--text-*`, then a literal).
5. The bundle (`lib/client.js`) must register via
   `window.__ModuleLoader__.load({ id: "<package-name>", factory })` — the
   `build-client.js` wrapper does this; the id MUST equal the package name.

### Manifest `dsh.client.inject`
List the packages that **own the slots you register into** (load-order edges):
`conversation.*` → `@deepseek-ai/dsh-client-ui-conversation`; `settings.section`
→ `@deepseek-ai/dsh-client-ui-settings`; `ctx.remote` → `@deepseek-ai/dsh-api-remotes`.

---

## 5. Remotes (host→client RPC, cross-session) — the hard part

For cross-session/durable data a `settings.section` panel needs (a projection is
per-session only). Pattern = `message-feedback`.

**Host:** `class X extends TypertRemoteService` (`super(ctx, "usage")` → namespace
`usage`), inject `storageDomain`, open a domain in `[Service.init]`, expose
`@Remote("overview")` methods. The gateway dispatches from the **runtime decorator
markers** — no Typert codegen needed.

**SRC method rule:** `@Remote` methods must use **plain identifier params, no
default values / destructuring / rest**. `overview(request = {})` fails with
`must use unique identifier parameters`. Normalize inside the body.

**Client:** `ctx.remote.<ns>` is normally populated only by codegen artifacts
imported into the harness's api-remotes bundle — **a third-party plugin can't
join that list**. Escape hatch: **`ctx.remote.$mount(contribution)`** at runtime
with a **hand-authored** `TypertRemoteContribution` (`{ package, descriptors[] }`;
descriptors are plain objects). Gotchas:
- The **client gateway requires STRICT codecs** (a zod schema with `.parse`) for
  params + result — `src-json` is host-only. Use permissive `z.any()` schemas.
- Do NOT put the namespace in the plugin-root `inject` (deadlock: `apply` must
  run to `$mount` it). Instead `$mount`, then register the consuming section from
  a **child** `ctx.inject(["slots", "remote.<ns>"], (c) => …)` scope.
- Remote methods resolve to a **`RemoteResult { ok, value } | { ok:false, error }`**
  — unwrap `.value`.

> **OPEN**: even after all the above, `dsh-usage-tracker`'s Settings panel renders
> empty in the user's live run while a headless probe of the same server shows
> data — likely a `$mount` timing/caching race. See `../dsh-usage-tracker/STATUS.md`.
> If Remotes prove too timing-fragile, prefer a **second projection** for the
> read path (client reads it the same reliable way as the per-session tab).

---

## 6. Test / iterate loop

```sh
# build + unit test the pure logic (fold/cost/aggregation) in plain node
cd ../dsh-<plugin> && npm run build && npm test && npm run type-check

# install into a throwaway (or ~/.dsh) profile
export DSH_HOME=$(mktemp -d)          # or ~/.dsh for the persistent one
cd ../deepseek-harness
node apps/cli/lib/bin.js plugin --profile web add github:<owner>/<repo>
#   pnpm may serve a CACHED copy — rm -rf $DSH_HOME/profiles/web/node_modules/<pkg> first

# add the client roster row so the modules loader mounts + scans it:
#   $DSH_HOME/profiles/web/cordis.patch.yml
#   - insert: [{ id: <id>, name: '<package-name>' }]

# boot (API key only needed to COMPLETE a turn, not to load plugins)
DEEPSEEK_API_KEY=... node apps/cli/lib/bin.js web --port 7400 --no-open

# verify headless (no browser needed) — Cairn has playwright:
#   NODE_PATH=/…/cairn/node_modules node probe.cjs   (goto, click tab, read innerText)
```

- Decompress a real session log to learn true event shapes:
  `zstd -dc ~/.dsh/sessions/*/session-*/session.jsonl.zstd | head`
- Durable store on disk: `~/.dsh/storages/<domain>.json`
- Verify the bundle is a registration: `grep __ModuleLoader__ lib/client.js`
- Verify `./react` is plain ESM (no `__ModuleLoader__`).

---

## 7. Recurring failure signatures → cause

| Symptom | Cause / fix |
|---|---|
| `declares dsh.client but exports no "./client"` | add `exports["./client"]` |
| `client bundle not found; run pnpm build` | `lib/` not committed / not in `files` |
| `ERR_MODULE_NOT_FOUND … lib/x.js` at boot | missing file in `files` (use `lib/**/*.js`) |
| `cannot get property "X" without inject` | add `X` to `inject` (but NOT a namespace you `$mount`) |
| `... did not activate: waiting for service X` | you injected something that never appears (e.g. self-mounted namespace) — deadlock |
| widget loads but renders nothing | wrong slot scope (no `useProjection`), or data-shape mismatch, or `promptTokens<=0` guard |
| popover "pops open" not floating | relying on Tailwind — use inline `position:absolute` |
| doesn't follow light/dark | hardcoded colors — use `--dsw-alias-*` / `--text-*` var chain |
| `SRC method must use unique identifier parameters` | `@Remote` method has default/destructured params |
| `field "result" has no strict codec` | client Remote contribution used `src-json`; use strict `z.any()` |
| Remote call resolves `undefined` totals | didn't unwrap `RemoteResult.value` |
| messages stop sending after install | a projection `apply` is impure/throws — make it pure + try/catch |
