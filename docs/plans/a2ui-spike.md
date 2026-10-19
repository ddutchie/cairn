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

## Prototype: `render_ui` chat tool (second commit)
- `render_ui` in `TOOL_SCHEMAS` (chat-only, so not exposed over MCP), `args = { title?, messages[] }` of A2UI v0.9 messages; listed in `APPROVAL_SAFE_TOOLS`. The executor (`chat-executor.ts`) validates the message envelope and returns an error so the model retries on malformed input.
- Renderer: `ConversationToolCall` draws a surface via lazy-loaded `A2uiToolSurface` (keeps the A2UI chunk out of the main bundle). Surfaces rebuild only when the payload content changes.
- Actions: `ConversationPane` provides `A2uiActionProvider`; a button press sends `[UI action] <name> <context json>` as the next user message through the pane's normal `onPrompt` (works for chat and coding panes).
- Verified: tests (`A2uiToolSurface.component.test.tsx`) and in the browser via the bubble on `/a2ui-spike` (form → button → user message with resolved context). NOT verified with a live model/Electron run, so prompt quality of the tool description is untested.
- Theming: `a2ui-theme.css` maps `--a2ui-*` onto Cairn tokens (derived vars must be redeclared, the catalog resolves them on `:root`). After an action the surface goes `inert`, dims and shows "Submitted · …"; the submitted flag persists per `callId` in localStorage.
- Open: form values are not restored on reload (only the submitted flag is); no per-surface update across turns (each call is a fresh surface); the tool description costs roughly 450 tokens per chat request.
