# Runtime plugins (author a plugin, load it live)

With **`CAIRN_PLUGINS_DEV=1`**, Cairn reads `<userData>/plugins/plugins.yml` and
hot-reloads it while the app runs — create/edit/delete a plugin and it loads,
updates, or unloads with **no restart**.

- macOS userData: `~/Library/Application Support/Cairn/plugins/`
  (or, when running under a custom dir, `$CAIRN_USER_DATA_DIR/plugins/`).
- Override the dir directly with `CAIRN_PLUGINS_ROOT=/some/dir`.

## Enable

Launch Cairn with the dev flag:

```bash
CAIRN_PLUGINS_DEV=1 npm run dev
```

## Manifest — `plugins.yml`

A top-level YAML array of entries. **Plain data only — no `!!js`** (a user/agent
file is untrusted; expressions are never evaluated).

```yaml
# A BACKEND plugin (adds tools/services on the agent context):
- id: hello-tool            # unique id (the live entry key)
  name: ./hello-tool.mjs    # relative file (new code), OR cordis:<shipped-builtin>
  config:                   # threaded to the plugin's apply(ctx, config)
    excitement: 3
  disabled: false           # optional; true = not mounted

# A UI plugin (draws chrome in the app — an overlay, a status bar item, …):
- id: bouncing-cat
  ui: ./bouncing-cat.plugin.js   # a renderer-side module exporting activate(ui)
```

An entry has `name` (backend), `ui` (frontend), or both. Edit this file while
Cairn runs: add → loads live; remove / `disabled: true` → unloads; edit the
file → reloads.

## A plugin file

A plugin is a Cordis plugin: a module exporting `apply(ctx, config)` (+ optional
`name` / `inject`). It runs on the SAME shared context as Cairn's agent, so it
can register tools, read services (`inject: ['tools']`), etc.

See `hello-tool.mjs` in this folder for a working example that adds an
agent-visible `hello` tool. Drop both files into your plugins dir, add the entry
to `plugins.yml`, and ask the agent to use the `hello` tool — live.

## A UI plugin (draws chrome in the app)

A UI plugin's code runs in the **renderer**. It exports `activate(ui)` and mounts
components into Cairn's **slot matrix** (`src/lib/plugin-ui/slot-matrix.ts`):

| API | Slot | What it does |
|-----|------|--------------|
| `ui.registerOverlay(id, C)` | `app.overlay` | frame-wide, click-through floating layer (badges, toasts, a bouncing cat) |
| `ui.registerStatusBarItem(id, C)` | `app.statusbar` | item in the bottom status bar |
| `ui.registerChatFooter(id, C)` | `chat.transcript.footer` | a band under the chat composer (cost/context widgets — gets Cairn's live usage) |
| `ui.registerToolView(tool, C)` | `tool.call.toolview` | a rich per-tool view in the chat transcript |

Use `ui.React` (Cairn's React instance) — **never bundle your own React**.

### Example plugins in this folder

| File | Kind | What it does |
|------|------|--------------|
| `bouncing-dvd.plugin.js` | UI (`app.overlay`) | the classic bouncing DVD logo — colour-changes on bounce, counts corner hits |
| `clock-statusbar.plugin.js` | UI (`app.statusbar`) | a live clock in the bottom status bar |
| `view-indicator.plugin.js` | UI (`app.statusbar`) | shows the active view — demonstrates slot **props** (`{ activeView, activeProjectId }`) |
| `hello-tool.mjs` | Backend tool | adds an agent-visible `hello` tool |
| `roll-dice.mjs` | Backend tool | adds a `roll_dice` tool (params + config) |

Copy any of them in, add its entry to `plugins.yml`, and it appears live.

## Notes / limits

- File plugins must be **pure JS/ESM** (no native addons — the app is
  arch-fenced + asar-signed).
- `apply` runs with full main-process privileges today. Untrusted third-party
  code sandboxing (node:vm / worker isolation) is a later step (§10 Tier 3 /
  the "Cairn Plugin Architecture" note).
- This is **dev-gated** (`CAIRN_PLUGINS_DEV=1`) until the settings UI + sandbox
  land.
