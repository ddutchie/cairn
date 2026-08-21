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
- id: hello-tool            # unique id (the live entry key)
  name: ./hello-tool.mjs    # relative file (new code), OR cordis:<shipped-builtin>
  config:                   # threaded to the plugin's apply(ctx, config)
    excitement: 3
  disabled: false           # optional; true = not mounted
```

Edit this file while Cairn is running:
- **add** an entry → the plugin loads live,
- **remove** an entry (or set `disabled: true`) → its live entry is torn down,
- **edit** an entry's file/config → it reloads (remove + recreate).

## A plugin file

A plugin is a Cordis plugin: a module exporting `apply(ctx, config)` (+ optional
`name` / `inject`). It runs on the SAME shared context as Cairn's agent, so it
can register tools, read services (`inject: ['tools']`), etc.

See `hello-tool.mjs` in this folder for a working example that adds an
agent-visible `hello` tool. Drop both files into your plugins dir, add the entry
to `plugins.yml`, and ask the agent to use the `hello` tool — live.

## Notes / limits

- File plugins must be **pure JS/ESM** (no native addons — the app is
  arch-fenced + asar-signed).
- `apply` runs with full main-process privileges today. Untrusted third-party
  code sandboxing (node:vm / worker isolation) is a later step (§10 Tier 3 /
  the "Cairn Plugin Architecture" note).
- This is **dev-gated** (`CAIRN_PLUGINS_DEV=1`) until the settings UI + sandbox
  land.
