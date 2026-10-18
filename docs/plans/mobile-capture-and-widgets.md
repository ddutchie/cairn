# Plan: Mobile capture that files itself, "your cairn grows", and widgets

**Status (2026-10-18):** Capture core + sheet are IMPLEMENTED on PR #241
(`claude/mobile-capture`): JS-only, type-check, lint (zero warnings) and unit tests
pass; CI green. The cairn stack is built but **DISABLED** (`SHOW_CAIRN_STACK = false`
in `ProjectsTreeSidebar.tsx`) after a first look on device; see "Revisit: cairn stack". Dictation, the App Intent and
widgets are DESIGNED here, not built. Their Swift can't be compiled in the cloud
sandbox, so each must be validated with an EAS `preview` build before TestFlight.

## Why

Give Cairn mobile a signature the other note apps lack, built from what Cairn already
has: on-device embeddings (`modules/apple-embeddings`), a provider layer
(`src/chat/providers`), a stack-of-stones identity, haptics, Skia, iCloud sync with the
desktop. Three ideas, in priority order:

1. **One-gesture capture that files itself**: drop in text or voice from anywhere;
   Cairn proposes project, note vs tasks, tags, `[[links]]`, due dates; one tap
   confirms. The capture-vs-organise trade-off disappears.
2. **Your cairn grows**: the home screen is a living stack of stones, one per recent
   note, newest on top; adding a note drops a stone with a settling haptic.
3. **Widgets**: glanceable overview panels and a one-tap Capture entry point on the
   Home and lock screens.

## Decisions (and why)

| Decision | Choice | Reason |
|---|---|---|
| Entry points for v1 | In-app capture sheet + `cairn://capture` link now; App Intent next; widgets after a spike | No extension target, app group or App Intents exist today. Do the cheap, verifiable entry points first. |
| Dictation | New Speech module (`SFSpeechRecognizer`, on-device where supported) | Chosen over keyboard-only dictation for hold-to-talk feel. Needs new Info.plist strings. |
| Filing AI | The user's configured provider with ONE schema-constrained tool (`file_capture`), plus a deterministic fallback | Apple's on-device model is dev-only (too weak); never block capture on AI. |
| Candidate retrieval | `semanticSearch` across workspaces (+ `finalizeRanking`); lexical title overlap when the index is empty | Index may be unbuilt or unsupported (iOS 17+, assets download). |
| Inbox project | **None.** Fallback = best match, else last project filed into (`capture_last_project`, device-local meta), else first project | Mobile has no project-create query; inventing a project would need columns/workspace plumbing. Zero projects: the sheet says to create one first. |
| Commit semantics | Always new rows through the query layer; undo = soft-delete (`softDeleteNote`, `deleteCard`) | Sync capture triggers stage plain writes; never edit existing note bodies (conflict copies exist for `notes.content`). |
| No-board-columns project | Tasks become a `- [ ]` checklist in the note | Don't drop the user's tasks. |
| Stack data | Deterministic from note ids (FNV-1a), newest 9 notes, content length → width | Same pile every launch; changes only when a note is added. No stored counter. |
| Stack (shipped state) | Built, switched off behind `SHOW_CAIRN_STACK` | First on-device look: did not look good. Code kept (layout, tests, Skia component) for a redesign. |
| Stack placement (when on) | Top of the iOS projects sidebar (`ProjectsTreeSidebar`) via `RNHostView` | On iOS the Projects tab always renders the SwiftUI `ProjectsSplitView`; the narrow `FlatList` header is Android-only. |

## Built (PR #241)

- `mobile/src/capture/`: `types`, `rank` (project scoring/pick), `proposal`
  (validation of model output against real ids, wikilinks only from exact titles,
  date/tag/task sanitising, fallback), `prompt` (+ `file_capture` JSON Schema),
  `extract` (context + provider call, 8s timeout, fallback), `commit` (+ undo).
  Pure modules are unit-tested (`*.test.ts` under the vitest "mobile" project).
- `app/capture.tsx` + `components/capture/CaptureSheet.tsx`: input, thinking and
  confirm-card stages; change project, untick tasks, rename note; Undo toast.
  Entry: Capture button in `ProjectsTreeSidebar`'s toolbar (iOS) and the Projects
  `Stack.Toolbar` (Android), deep link `cairn://capture?text=&autostart=1`.
- `gamification/stones.ts` (pure layout, tested), `useRecentStones`,
  `components/CairnStack.tsx` (Skia; spring drop + `haptics.settle()`; tappable
  stones open the note via `showNoteInSplitView`), `listRecentNotes` query.

## Still to do

### A. Dictation (native, EAS build)
- `mobile/modules/apple-speech/` in the existing local-module pattern
  (`expo-module.config.json`, `index.ts`, podspec, `AppleSpeechModule.swift`,
  `requireOptionalNativeModule`). Swift: `SFSpeechRecognizer` with
  `requiresOnDeviceRecognition` when supported, `AVAudioEngine`; events
  `partial` / `final` / `error`; API `isAvailable`, `requestPermission`, `start`, `stop`.
- Config plugin `plugins/withSpeechPermissions.js`: `NSMicrophoneUsageDescription`,
  `NSSpeechRecognitionUsageDescription`.
- `useDictation` hook + hold-to-talk mic in `CaptureSheet`; partials stream into the
  field; release runs "File it". Hidden when unavailable / Android.

### B. App Intent (native, EAS build, SPIKE FIRST)
- `mobile/modules/capture-intents/`: `CaptureToCairnIntent(text: String)` with
  `openAppWhenRun = true` and an `AppShortcutsProvider` ("Capture to Cairn").
  Gives Siri, Shortcuts, Spotlight and the Action Button.
- Hand-off: intent writes the text to a pending-capture key; the app reads it on
  foreground and routes to `/capture?autostart=1` (more reliable than a URL).
- **Risk:** App Intents metadata extraction from an autolinked static framework.
  Prove an intent shows up in Shortcuts from a preview build before building more;
  fallback is a small config plugin that puts the intent in the app target.

### C. Widgets (native, EAS build, SPIKE FIRST)
The overview already computes everything needed in `summarizeProject`
(`components/overview/project-summary.ts`): completion %, open/overdue/today counts,
bottleneck. Candidates:

| Widget | Family | Content |
|---|---|---|
| Progress ring | small | one project's completion; project chosen in widget config |
| Today | medium | due today / overdue / open + top due tasks |
| Capture | Home, lock-screen accessory, iOS 18 Control | one tap opens `cairn://capture` |
| Cairn stack | small/medium | stones drawn natively from saved geometry (app stores the output of `layoutStones`; the widget just draws rounded rects) |
| Health radar | - | **skip**: complex to redraw natively, low value at glance size |

Architecture:
- WidgetKit extension target in SwiftUI (cannot reuse RN views); target added to the
  CNG project by a tool such as `@bacons/apple-targets`. `plugins/withAppleSigning.js`
  already signs every target with a bundle id.
- App group entitlement (new `withAppGroup` plugin). The widget can't read the app's
  private SQLite DB, so the app writes a small JSON **snapshot** into the shared
  container on data change (reuse `onDataChanged`) and reloads timelines via a tiny
  native bridge (`WidgetCenter.reloadAllTimelines`). Keep the snapshot builder as pure,
  tested TypeScript (`summarizeProject` + stone geometry → JSON).
- Deep links go to existing routes (`cairn://capture`, project/note routes).
- **Needs the owner:** register the app group in the Apple Developer account and
  approve the extra bundle id / provisioning in EAS credentials.
- Spike scope: extension + app group + snapshot pipeline + a static Capture widget and
  one progress-ring widget. Expand only after a preview build proves the pipeline.

### Revisit: cairn stack
First on-device look (iPhone Duo closed-pose, light theme): the stack read as a tall
pile of near-identical grey pills in a big white card, not stones. Ideas for the redo:
- **Shape:** irregular pebble/stone paths (varied corner radii, slightly asymmetric)
  instead of uniform rounded rectangles; very small rotation only.
- **Colour:** real per-stone variation (warm greys/sand with an accent-tinted few)
  instead of one grey plus a faint accent wash; keep the newest stone in the accent.
- **Scale:** fewer stones (5–6), smaller footprint; consider a compact header glyph
  or a lock-screen/widget presentation rather than a 220pt-wide card in the sidebar.
- **Depth:** a soft contact shadow under each stone so the pile has weight.
- **Context:** judge it on dark theme and the narrow phone column too; it was only
  seen on the Duo's closed outer display.
- **Fix before enabling (CodeRabbit finding):** `CairnStack` animates when `newestId`
  changes, so switching workspace, or deleting/archiving the top note, would wrongly play
  the drop and haptic. Pass the active workspace identity and reset the arrival baseline
  when it changes; within a workspace ignore older top-note replacements, using an
  explicit add/sync event or a deterministic order key (equal `createdAt` values are
  possible and `listRecentNotes` has no tie-breaker) to tell a real arrival apart.
To turn it back on: set `SHOW_CAIRN_STACK = true` and re-add the changelog entry
("Your cairn grows" under 0.1.13 Added).

### D. Stretch: resurfacing
Daily "stone to revisit": a note related to current work via `relatedNotes` /
`semanticSearch`, picked stably per day (pure `dailyRevisitPick(date, notes)` + test).
Could surface in the sidebar, the Today widget, or a lock-screen accessory.

### E. Later
Share extension (reuses the app group from C); lock-screen Control widget for capture
(needs the widget extension).

## Risks and open questions

- **Everything is unverified on device.** Check: Skia canvas sizing inside the SwiftUI
  sidebar (`RNHostView matchContents`, fixed 220pt); the sidebar Capture button
  placement; iPhone Duo poses.
- **Apple provider:** the model's answer is read from a `file_capture` tool call
  (`tool-input-available` / `tool-executed`). The Apple PCC provider executes tools
  itself; confirm filing still yields a proposal rather than silently falling back.
- **Swift must compile on the EAS image** (`eas.json`: `macos-tahoe-26.6-xcode-27.1`)
  and stay green on stable SDKs; see `apple-foundation-models-provider.md` for the
  `CAIRN_PCC_SDK` gating pattern when using newer-SDK-only symbols.
- **Cost/latency:** one provider call per capture, ~1.5K prompt tokens, 8s cap.
- **Android:** the stack and sidebar Capture button are iOS-only; Android keeps the old
  Projects list and the `Stack.Toolbar` Capture button.
- Open: should capture also create a card-only mode from the Board tab? Should the
  stack count tasks as well as notes?

## Verification

- `cd mobile && npx tsc --noEmit && npx eslint --max-warnings 0 .`; from the repo root
  `npx vitest run mobile` (pure logic: `src/capture/*`, `src/gamification/stones`).
- Capture cases: provider offline; none configured; embeddings index empty; model
  returns unknown project/note ids; very long text; Undo after confirm; capture while
  a sync is in flight (no duplicate/overwritten rows after the next sync).
- Device/preview-build only: keyboard + paste capture, stone drop + settle haptic,
  reduced motion, Duo poses; for A/B/C an EAS `preview` build before any TestFlight.
