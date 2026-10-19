# A2UI spike (branch `spike/a2ui`)

Playground: `/a2ui-spike` (dev server) → `src/components/a2ui/A2uiPlayground.tsx`.
Uses `@a2ui/react@0.14.0` + `@a2ui/web_core@0.14.0`, protocol v0.9, `basicCatalog`.

## Verified in the browser (next dev)
- `createSurface` / `updateComponents` / `updateDataModel` render a Card + TextField + ChoicePicker + CheckBox + Button.
- Two-way binding writes into the data model; the Button action reaches the `MessageProcessor` action handler with its `context` already resolved from the data model (`{ title, priority, started }`). That handler is where a Cairn tool call (e.g. create card) would hang.
- Streaming messages one at a time works; unresolved children show a `[Loading root…]` placeholder until they arrive.
- The page already picks up Cairn's dark theme; the "script tag" console error also appears on `/`, so it is pre-existing.

## Findings / risks
- v0.9 basic catalog renders as W3C custom elements (`<a2ui-react-*>`), not React components; no SSR (fine for our static export, client-only).
- `zod` peer is `^3.25.76`; we are on zod 4, so npm nests a second zod 3 copy (bundle size, not a conflict).
- Package size on disk: web_core 15 MB, react 5.9 MB, markdown-it 1.9 MB — check the renderer chunk size before shipping; load it lazily.
- Docs say the project is early-stage public preview; v1.0 is a release candidate, `@a2ui/agent` is unpublished.
- Agent output must be treated as untrusted: catalog restricts components, but add validation (`STRICT_VALIDATION`) and keep image/video URLs and Markdown under CSP.
- Not verified: `next build` static export, Electron packaging, styling against Cairn tokens (`--a2ui-*` vars), wiring to Cordis tool calls.

## Likely integration shape
1. A Cordis tool (e.g. `render_ui`) whose argument is the A2UI message list; the chat timeline renders it in a surface under the tool result.
2. Surface action → `processor` action handler → send a user message/tool result back to the same turn (or a Cairn IPC call for direct actions like "create card").
3. Map `--a2ui-*` CSS variables onto Cairn's `--accent`, `--surface`, etc.
