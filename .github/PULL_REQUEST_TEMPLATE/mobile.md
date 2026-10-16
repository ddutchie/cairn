## What does this PR do?

<!-- A short description of what changed and why. 1–3 sentences is enough for small changes. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / code quality
- [ ] Docs / changelog
- [ ] Tests

## Screenshots / recording

<!-- For any UI change, include a screenshot or short screen recording (iPhone, and iPhone Duo / iPad poses where relevant). Delete this section if not applicable. -->

## Checklist

- [ ] `npx tsc --noEmit -p .` passes in `mobile/`
- [ ] `npx eslint` is clean on the changed files in `mobile/`
- [ ] Unit tests pass for any logic touched (run from the repo root, e.g. `npx vitest run mobile/src/lib/fold.test.ts`)
- [ ] Entry added to the pending `mobile/changelogs/v*.md` (the next version above `expo.version` in `mobile/app.json` — see "Changelog rule" in `AGENTS.md`); version not bumped
- [ ] Colours come from the theme (`useTheme()` tokens), not hardcoded hex/rgba
- [ ] Font sizes use the theme type scale so they follow the font-size setting
- [ ] Toolbar items supply both an icon and a title, so they can sit in the iPhone Duo side rail and overflow menu
- [ ] No new width breakpoints — use `WIDE_MIN_WIDTH` from `src/lib/layout.ts`, and `useFold()` for anything that must avoid the crease
- [ ] New native module / config plugin / Podfile change is called out below (needs a native rebuild)
- [ ] No new `dependencies` without a note on why, and nothing that drops arm64 or breaks the SDK 58 / React Native 0.88 pairing

### Poses and surfaces checked

<!-- Tick what you actually ran, and say what you could not check. Pose-dependent layout is not decidable from code. -->

- [ ] iPhone (compact)
- [ ] iPhone Duo — closed (outer display)
- [ ] iPhone Duo — book (landscape, half-fold)
- [ ] iPhone Duo — laptop (portrait, half-fold)
- [ ] iPhone Duo — Split View / Picture-in-Picture
- [ ] iPad
- [ ] Android (if the change is cross-platform)

## Notes for reviewer

<!-- Anything you're unsure about, decisions you'd like feedback on, or areas to pay extra attention to. Delete if not needed. -->
