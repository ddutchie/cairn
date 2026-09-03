# dsh UI Checklist — Per-Bump Web-Shell Review

> Cairn ships its own renderer, not the dsh web shell — never adopt a
> `dsh-client-*` package. This checklist exists so each dsh bump still
> surfaces the UI behavior worth mirroring (or deliberately skipping).
> Companion to `dsh-upgrade-guide.md` (run after §3, the tarball diff).

## Where to look

1. **Release notes UI sections** (`github.com/deepseek-ai/deepseek-harness/releases`):
   Improvements / New Features entries tagged to conversation, header,
   composer, theme, i18n contributors are the UI surface.
2. **Client package READMEs at the tag** (npm pack, like any lib):
   `dsh-client-ui-subagent`, `dsh-client-ui-schedule`, `dsh-client-ui-jobs`,
   `dsh-client-ui-conversation`, `dsh-client-ui-workspace`, `dsh-client-ui-plan`,
   `dsh-web-app`. All ride the same `next`/`alpha` tags as the libs.
3. **The `slots` contract** (`dsh-client-ui-*` Summary sections name their
   `conversation.*` slots). If a new slot appears that a Cairn view could
   occupy, note it — do not implement against it.

## Standing checklist (checked at 0.1.2-rc.1)

| Upstream surface | What it does | Cairn equivalent | Status |
|---|---|---|---|
| Subagent header catalog (`ui-subagent`) | Header count trigger → descendant tree (mode, activity, usage, duration); open child read-only (one-shot) or with composer + Stop (continuable) | `SubagentCatalogAction` in `ConversationHeader` actions + trace blocks | ✅ implemented on `ddutchie/dsh_012` (catalog, message, Stop; no per-child duration/usage yet) |
| Schedule header catalog (`ui-schedule`) | Read-only active-reminder popover, overdue first, locale-relative times | — | 🔲 blocked on PR-2 (Schedule mount) |
| Job list (`ui-jobs`) | Header badge + popover over `jobsBySession` mirror (live first, settled visible) | — | 🔲 no Cairn surface (jobs exist since this branch; UI deferred) |
| Turn navigation (`ui-conversation`) | Right-hand rail: preview + jump to paginated turns incl. unloaded | — | 🔲 no Cairn equivalent; consider for long sessions |
| Per-answer usage + elapsed (`ui-conversation`) | Exact token usage + timing under each answer, expandable | Per-message stats line (`MessageStats`) | ✅ already mirrored (v3.0.0) |
| Optimistic submit echo | Pending turns render instantly at chat tail | Queue dock (`ConversationQueueDock`) | ✅ equivalent exists |
| Connection status + reconnect | Failure banner, auto-retry, reconnect action | n/a (in-process; no remote connection) | ➖ intentionally skipped |
| Plugin scope grouping + preset switching | Conversation vs global plugin lists, Agent Preset search | Settings → Extensions | ➖ different model (Cairn has no presets/web shell) |
| `@` subagent references (`ui-subagent`) | Inert `@label` text inserts, no resolution | Mention suggestions (`@` menu) | ➖ intentionally skipped (no continuation semantics) |
| Theme tokens (`--dsw-*`) | `dsh-client-ui-theme` stylesheets | Cairn `--*` tokens + `dsw-theme.css` shim for vendored cards | ✅ shim exists; revisit if community cards drift |
| i18n (`dsh-client-locale`, third-party languages) | zh/en + registered languages | Cairn is English-only | ➖ intentionally skipped |
| PTC mode composer (`ui-plan`) | Plan-mode input seat over plan projection | Plan toggle + `exit_plan_mode` review card | ✅ equivalent exists |

Legend: ✅ mirrored · 🔲 open future work · ➖ deliberately not applicable.

## Rules

1. **Mirror behavior, never packages.** A web-shell feature is a spec (see the
   package READMEs' Use-this-package sections); re-implement in Cairn grammar
   (`rem` sizes, `var(--*)` colors, existing slots).
2. **One header slot per concern.** Upstream orders header actions
   Agent/Subagent context → Schedule → Jobs. Cairn's `ConversationHeader`
   `actions` slot follows the same order when several are present.
3. **Read-only first.** Upstream ships catalogs read-only and adds mutation
   later (`ui-schedule` has no create/delete; `ui-jobs` rows are read-only).
   Do the same — list before message/stop.
4. **Update this table every bump.** A row that flips needs a plan note or a
   deferral reason, same as the capability matrix in `dsh-upgrade-guide.md` §6.
