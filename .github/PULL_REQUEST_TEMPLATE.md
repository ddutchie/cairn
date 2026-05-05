## What does this PR do?

<!-- A short description of what changed and why. 1–3 sentences is enough for small changes. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / code quality
- [ ] Docs / changelog
- [ ] Tests

## Screenshots / recording

<!-- For any UI change, include a screenshot or short screen recording. Delete this section if not applicable. -->

## Checklist

- [ ] `npm run type-check` passes
- [ ] `npm test` passes
- [ ] `npm run test:e2e` passes (run before merging UI changes or cutting a release)
- [ ] No hardcoded colours — CSS variables only (`var(--accent)`, `var(--text-primary)`, etc.)
- [ ] No `text-[Npx]` pixel font classes — rem equivalents only (`text-[0.714rem]`, `text-xs`, etc.)
- [ ] New IPC handlers wrapped in `handle()` and return `IpcResult<T>`
- [ ] New DB migrations appended (not edited) in `schema.ts`
- [ ] `mcp-server.ts` changes use inlined SQL only — no import from `queries.ts`

## Notes for reviewer

<!-- Anything you're unsure about, decisions you'd like feedback on, or areas to pay extra attention to. Delete if not needed. -->
