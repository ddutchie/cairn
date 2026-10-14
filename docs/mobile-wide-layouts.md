# Mobile wide layouts — iPad & iPhone Duo

How Cairn Mobile lays out Projects (and the Chat preview) on wide windows: the
unfolded iPhone Duo and the iPad. Spike branch `spike/duo-split-view`.

## Canonical Apple docs (start here)

- [Prepare — iPhone Duo](https://developer.apple.com/iphone-duo/prepare/) (SDK tiers + resizing checklist)
- [Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo.md) (canonical overview)
- [Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo) (HIG; raw markdown: `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/designing-for-iphone-duo.md`)
- Tech Talks: [Prepare your app for iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111461/) · [Strike a pose with adaptive layouts](https://developer.apple.com/videos/play/tech-talks/111463/)
- API: [`ArrangementView`](https://developer.apple.com/documentation/swiftui/arrangementview.md)

For agents: prefer the `.md` endpoints where available; several
`developer.apple.com` HTML pages require JavaScript. Device/OS research lives
in `docs/plans/iphone-duo.md`.

## Devices and what differs

| | Folded Duo / iPhone (compact) | iPhone Duo, unfolded | iPad |
|---|---|---|---|
| Window | < 700pt | ~951pt landscape / ~710pt portrait | 1032pt+ |
| UI idiom | phone | **phone** | pad |
| Tab bar | bottom bar | **side rail** (84pt right inset) | **floating pill** in the top row |
| System tab sidebar | no | **no** (idiom gate, see below) | yes (`sidebarAdaptable`) |
| Projects layout | collapsed split (one column) | split view | split view |
| Project / view picker | project list column + view switcher | project list column (or its toggle) + view switcher | project list column + view switcher |
| Column buttons | column's SwiftUI bar | each column's SwiftUI bar | stack header (shares the pill's row) |

iOS always mounts one `NavigationSplitView` (`app/(tabs)/projects/index.tsx`
renders `<ProjectsSplitView>` unconditionally); it collapses to a single
column when compact, driven by `preferredCompactColumn` (other platforms keep
the old width-switched list).

## Component map

```
app/(tabs)/projects/index.tsx      iOS → always <ProjectsSplitView> (collapses
                                   when compact); other platforms keep the
                                   width-switched list
└─ ProjectsSplitView               one NavigationSplitView, always mounted:
                                   Sidebar (project list) | Content (view) |
                                   Detail (open note/task, else the view's
                                   overflow panel — the slot is always reserved)
   ├─ Sidebar:   ProjectsTreeSidebar (native bar: workspace menu, sync/settings;
   │              flat project list: own icon, name, "N notes · N tasks")
   ├─ Content:   ChromeColumn ▸ ProjectViewSwitcher + ProjectScreen (overview |
   │              notes | board) or ProjectCalendarScreen — the view switcher
   │              (Overview | Notes | Board | Calendar) is the way to change view
   └─ Detail:    ChromeColumn ▸ NoteDetailScreen | NoteComposer |
                  CardDetailScreen | TaskComposer, else the overflow panel:
                  Overview → recent notes + activity (OverviewPanel),
                  Board → status blocks (OverviewPanel), Calendar →
                  CalendarDayPanel, Notes → "No note selected",
                  no project → "No project selected"

app/(tabs)/chat/index.tsx          width ≥ 700 → ChatPreviewPane beside the chat
                                  (the board's old task panel moved to Detail)
```

### Selection
A module-level store in `ProjectsSplitView` (`{ projectId, view, noteId, cardId }`
via `useSyncExternalStore`). It lives outside React so the open item survives
fold/unfold — and opening an item never switches the view: the item renders in
Detail whatever Content shows. `preferredCompactColumn` follows the selection
depth (tree → view → item) and the native Back feeds back into the selection,
so compact drill-down needs no router pushes.

### Screens in columns — `screen-chrome.tsx`
Screens describe their title and toolbar once as data (`<ScreenChrome>`). Where
it renders depends on context:

- **Route** (phone): `Stack.Screen` + `Stack.Toolbar`, as before.
- **Column** (`<ChromeColumn>`): the column's own SwiftUI navigation bar. The
  screen reports its spec through context; handlers are looked up at press time.
- **Bridged column** (iPad, `slot="primary" | "secondary"` under a
  `ChromeBridgeProvider`): the column hides its bar and its items are drawn as
  `Stack.Toolbar` items left / right of the floating tab bar. Why: SwiftUI puts
  column bars *below* the pill's row, wasting a band of height; the native stack
  header shares the pill's row.

### Where buttons go
- **iPad** — the stack header in the tab bar's row: the sidebar toggle first
  (the system hides the tree for room on narrow windows and its own toggle
  is bridged away with the column bars), then the list's / board's items;
  the open note's or the view's own items (Overview, Calendar) right of the
  tab bar.
- **Duo** — the bar that docks into the side rail. Every column owns its bar:
  the sidebar (workspace menu, sync, settings), the view, and the open item
  (which also carries the list's items on Notes — the list keeps just its
  title while a note is open).

### Picking a project and view
A **flat project list** in the sidebar column chooses the project; a **segmented control**
at the top of the project column changes its view — see "Projects navigation" below for
the model and why the nested tree was dropped. The system tab sidebar
(`modules/tab-sidebar`, flag-gated) is a possible future renderer for the same list; the
split-view sidebar column serves both devices today. The old slide-over
`ProjectsTreePanel` is deleted.

### The open item
The note open beside the list is tinted in it (`NoteRowItem selected`), and the
task open beside the board is outlined on its card (`DraggableBoard
selectedCardId`) — both via `ProjectScreen selectedId`.

### Hinge (Duo)
The hinge *status* is fed to the cache in `src/lib/hinge.ts` by **`expo-hinge`** (Expo SDK 58: `useHinge` /
`getHinge` / `addHingeListener` → `{ angle, status }`, iOS 27.1 via `UIHingeInteraction`, Android 11+ via
WindowManager). It works from plain JS (no SwiftUI host needed) and seeds synchronously, so the first render
already knows the pose. It is the *only* source: the invisible `HingeObserver` and the `onHingeChange`
modifiers were removed (SidePreview and the split view read `useHingeStatus()`). The
Fold overlay shows the live angle (`hinge=closed@0°`). expo-hinge says to use hinge state for effects, not
layout — the crease *geometry* is `modules/fold-region`. Android never reports `closed` (only `unknown` when
the window doesn't span the fold), so `statusFromHinge` (`src/lib/hinge-status.ts`, unit-tested) treats an angle
below 15° as closed there — untested on a device. The cache is read by
`useFold` and the split view (`hingeClosed`). Column widths are SwiftUI's job entirely — no pins: a
plain number is a FIXED column that can't follow pose changes, and even soft
`{ min, ideal }` ideals visibly missed the crease across poses while the
unpinned board always reflowed correctly. So every column is unpinned
(`balanced` style does the hinge-centring itself).
Note: `onHingeChange` is a no-op with precompiled Expo modules — builds need
`EXPO_USE_PRECOMPILED_MODULES=0` (release: `ios.usePrecompiledModules: false`
and an Xcode 27.1 EAS image).

### Task / note side panel — `ChatPreviewPane`
One animated width (Reanimated) slides a note or task in from the right beside
the chat, so neither remounts. Half open on a Duo it starts exactly on the
hinge. (The board's old task panel is gone — open tasks live in Detail now.)

## Native additions (what's not stock Expo)

Nothing in `node_modules` is patched. There are three local Expo modules (`swiftui-modifiers`, `tab-sidebar`, `fold-region`):

### `modules/swiftui-modifiers` — `navigationBarHidden()`, `forceCompactWidth()`, `forceCompactBelow()`
Registers custom @expo/ui modifiers via `ViewModifierRegistry` — @expo/ui's own
extension point, tiny and stable:
- `navigationBarHidden()` — `.toolbar(.hidden, for: .navigationBar)`; used by
  bridged columns on iPad.
- `forceCompactWidth(enabled)` — `.environment(\.horizontalSizeClass, .compact)`
  while enabled; used by `ProjectsSplitView` below 700pt (see "Projects in a narrow
  regular-width window"). Always the same single environment modifier with a changing
  value, so toggling it never changes the view's identity (no remount).
- `forceCompactBelow(threshold)` — the same override, decided **natively**: SwiftUI measures the
  view's own width (`onGeometryChange`) and forces compact below `threshold` in the same layout
  pass. This is what `ProjectsSplitView` uses (700pt). The JS-flag version lagged a beat behind
  the window on unfold (see "Fold/unfold transitions"). Starts narrow; the first geometry
  report corrects a wide start.

### `modules/fold-region` — the real crease (iOS 27.1)
Exposes the active *division* `ReservedRegion` of the foreground scene's key window, in window
coordinates, as `getDivisionRegion()` + an `onDivisionRegionChange` event. It calls
`UIView.reservedRegions(kind:)` through the Objective-C runtime (selectors + KVC), so it builds on
any Xcode and reports `supported: false` on older iOS. A transparent probe view in the window
(`updateProperties()` — UIKit re-runs it when the regions it read change — plus `layoutSubviews`)
re-publishes on pose changes and resizes; events are deduped on frame **and** `supported`.
JS: `src/lib/division-region.ts` (store, `useDivisionRegion`: `undefined` = API unavailable,
`null` = available, no active region), `src/lib/fold.ts` (`foldFromRegion` clips the frame to the
window; `resolveFold` falls back to the inferred `foldGeometry`), `useFold`. Needs a native rebuild.

### `modules/tab-sidebar` — Mail-style groups in the iPad tab sidebar
react-native-screens (4.28, also 5.0 alpha) builds its `UITabBarController` from
plain view controllers, so the sidebar can only list tabs flat. The module, on
iPadOS 18+:

1. finds the tab bar controller in the window hierarchy;
2. rebuilds its `tabs` with UIKit's tab API: Projects becomes a `UITabGroup`
   whose own view controller is the original Projects screen, with sidebar-only
   child rows (projects → views) that have **no** view controller — selecting
   one keeps showing Projects, so react-native-screens sees an ordinary
   selection of that tab;
3. wraps react-native-screens' delegate in a forwarding proxy to hear which row
   was picked, and reports its id path to JS;
4. re-applies itself if react-native-screens resets the tabs.

Fragile points: it replaces react-native-screens' tabs behind its back (an
upstream change to how it manages controllers could break it), it recognises the
search tab by its system title, and UIKit lists groups after plain tabs and adds
a customisation "Edit" button.

## Gotchas found along the way

- **Duo is phone idiom.** `List` selection only works in edit mode → rows select
  with `onTapGesture` + a drawn highlight. `UITabBarController` in `tabSidebar`
  mode reports regular width yet never draws a sidebar (which is why the tree
  lives in a split-view column instead of the tab sidebar).
- **SwiftUI reserves the Detail slot even when empty.** Conditionally unmounting
  the Detail column trades a placeholder for a blank page (verified), and no
  width trick reclaims it — explicit full-window widths overflow in poses where
  the sidebar is visible. So Detail always hosts something: the open item, else
  a per-view action panel (`DetailActionPanel`).
- **No column width pins.** Fixed numbers freeze a pose; `{ min, ideal }` ideals
  still missed the crease across poses. Unpinned columns under `balanced` reflow
  correctly everywhere (the board proved it first).
- **Controlled `columnVisibility` only settles when SwiftUI's reports are
  acknowledged.** Passing a constant (e.g. always `"all"`) while ignoring
  `onColumnVisibilityChange` parks columns in limbo (sidebar stuck as an
  overlay). The split starts at `"doubleColumn"` and echoes every report back,
  swallowing only the spurious first-layout `detailOnly` with nothing open;
  focus mode passes an explicit `detailOnly` while on. Compact passes
  `"automatic"` (same as uncontrolled).
- **iPad leading header items** fold into a "⋯" overflow on a cold start when an
  item has a long text label → icon-only items.
- **One stable `Host`, never moved or keyed.** A hosted RN view moved into a
  different SwiftUI column renders blank — so the split view (and its `Host`)
  mounts once and columns only ever swap *content*, never containers.
- **Stack.Screen options persist** → route screens set `headerShown` and
  `contentStyle` explicitly so the split view's overrides don't stick when
  navigating back to phone-style routes (Android, root-stack pushes).

## Poses — what the app can see (iPhone Duo, measured 2026-10-12)

Apple's six poses (closed, tent, open-wide, half-folded book, open-tall, laptop)
as the Duo simulator reports them to the app (window pts / safe-area insets /
`onHingeChange` status):

| Pose | Window | Insets T/B/L/R | Hinge | Fold |
|---|---|---|---|---|
| Closed (outer display) | 466×678 | 0/34/0/84 | `closed` | none |
| Open, tall (flat) | 669×951 | 82/34/0/0 | `fullyOpen` | none |
| **Laptop** (portrait half-fold) | 669×951 | 82/34/0/0 | `partiallyOpen` | **horizontal**, mid-height |
| Open, wide (flat) | 951×669 | 0/34/0/84 | `fullyOpen` | none |
| Book (landscape half-fold) | 951×669 | 0/34/0/84 | `partiallyOpen` | vertical, mid-width |

Gotchas:
- **Laptop and tall are identical** except for the hinge status — same window,
  same insets. The status is the only signal, and it carries no axis or frame.
- The status also reads `partiallyOpen` transiently on the 466×678 outer display
  while folding/unfolding; `foldGeometry` ignores windows with a short side
  under 600pt.
- The simulator exposes no distinct tent/kickstand pose; the closed device on
  its side is the outer display (app stays portrait-only, so it rotates with the
  device). No custom layout is needed — there is no crease.
- Headless screenshots (`simctl`/the sim tool) never draw the crease; judge
  folds from the Device Hub window or the debug band below. Tab-pill taps from
  automation are flaky; pose changes can't be scripted (Device Hub hosts the
  simulator, not Simulator.app).

### How screens avoid the crease (laptop pose)

`src/lib/fold.ts` (pure + tested) resolves the crease two ways, `resolveFold`:

- **Native (iOS 27.1+)**: the local `modules/fold-region` Expo module reads the
  active *division* `ReservedRegion` of the foreground scene's key window
  (`UIView.reservedRegions(kind: .division)`; occlusion = camera, unused) and
  publishes its frame in window coordinates. `foldFromRegion` clips it to the
  window and derives axis (wider-than-tall band → horizontal), position (band
  centre) and gutter (band thickness, margins included). So Split View works: a
  window clear of the crease gets no fold, one abutting it sees only the sliver.
  `src/lib/division-region.ts` is the store (`useDivisionRegion`; `undefined` =
  API unavailable, `null` = available but no active region, e.g. flat or the outer
  display). The module calls the API through the ObjC runtime (selectors + KVC), so
  it builds on any Xcode and reports `supported: false` on older iOS; a probe view
  in the window (`updateProperties`, which UIKit re-runs when the regions it read
  change, plus `layoutSubviews`) emits `onDivisionRegionChange` on pose changes
  and resizes, and `useFold` also re-queries on hinge/window change.
- **Fallback (old iOS, Android, build without the module)**: `foldGeometry` infers
  from hinge status and window shape: `partiallyOpen` on an inner-size window →
  horizontal crease at mid-height when portrait, vertical at mid-width when
  landscape, ~20pt gutter. Wrong in Split View (assumes the window fills the display).

`src/lib/hinge.ts` is now reactive (`useHingeStatus`); `src/lib/use-fold.ts` has
`useFold()` and `useTopHalf()` (room above a horizontal crease, in a container's
own coordinates — null once the container already sits below it).

- **Chat** fills the window — the transcript may scroll under the crease — until
  its own input has the keyboard. Then it is confined above the crease (the
  composer rides up onto it; the keyboard is exactly the flat half): lift is
  `never`, `offset` is the real gap to the window bottom (`useTopHalf().gap`; the
  default tab-bar offset made the library inset the transcript by nearly the
  whole keyboard and scrolled the messages out of view), and bottom padding is
  only the composer's overlap with the transcript's bottom edge (no tab-bar lift).
- **Side preview** (`SidePreviewLayout`, shared by Chat/Graph/Calendar): when
  stacked, the pane sits above the crease and the screen body below it (a column
  instead of a row; the pane animates its height). Header treatment matches the
  wide case. The keyboard is the whole flat half, so a stacked chat would sit
  behind it: while the chat's own input is focused `collapsePane` slides the pane
  shut (it stays mounted at full size, only its clipping frame shrinks, so an
  unsaved note edit survives and nothing re-lays out) and the chat fills the top
  half with its composer on the crease; it re-expands when the keyboard goes. While
  the note is being edited instead, the chat composer `hidden`s (it would float over
  the editor). Keyboard lift is `never` throughout the stacked layout. With a
  preview open the header's context ring and clear-chat button step aside (the
  pane's ✕ sits under the ring and the ring swallowed its taps) and go into a small
  glass capsule at the bottom-left, on the tab bar's row in the room beside it —
  except while typing, when the pane is slid away and they return to the header.
  The ring's popover opens upward from the capsule. (The ring is a native
  `matchContents` host — leave it self-sizing in a centred RN slot: a fixed-size
  host pins its SwiftUI content to the top-left.)
- **Calendar**: the grid flexes down to the crease; the bottom band (selected-day
  list + Unscheduled tray) is sized to the flat half.
- Projects (split view) is system-managed; Graph and Overview — see the survey.
- Debug aid for pose work: Settings → Appearance → Developer → **Fold overlay**
  (dev builds only; `src/lib/dev-flags.ts`, `FoldDebugOverlay`) prints
  window/insets/hinge and the crease source (`fold=native|native:none|inferred`) along the top and draws the crease band, since
  simulator screenshots never show the fold. Persisted in the meta DB, forced
  off in release builds.

### Projects navigation: flat list + view switcher (2026-10-13)

The Projects split view's sidebar used to be a tree (each project expanding to
Overview / Notes / Board / Calendar rows). Collapsed (phone, folded Duo, narrow
windows) that meant going Back to the tree to change a project's view. Now:

- The **sidebar is a flat list of projects** (`ProjectsTreeSidebar`,
  `useProjectsList` in `projects-tree.ts`): the project's own icon (shared Lucide
  name → SF Symbol, `SF_FOR_ICON`), name and "N notes · N tasks". It only chooses the
  project; choosing one keeps the current view and closes any open item.
- A **segmented control** — `ProjectViewSwitcher`: Overview | Notes n | Board n |
  Calendar — sits at the top of the project column at every width, and sets the same
  `selection.view` the tree rows did, so fold/unfold continuity is unchanged (the
  component tree doesn't change; the selection lives in the module-level store).
  `ProjectScreen` / `ProjectCalendarScreen` take it as a `switcher` prop and draw it
  (the route copies of `ProjectScreen` keep their own three-segment control).
- The default view for a fresh selection is Overview (was Notes).
- **Re-tapping the Projects tab** returns to the project list: the tab hosts a SwiftUI
  split view whose collapsed stack is our own selection state, so the native tab bar's
  pop-to-root had nothing to pop; `app/(tabs)/_layout.tsx` listens for `tabPress` on
  the Projects trigger and calls `resetProjectsSelection()` when it's already focused. Folded
  that lands on the project list; wide it clears the selection, so the sidebar opens with
  "No project selected" in the detail column (see "Wide layout" below).
- The demo seed's project icons are emoji, which aren't Lucide names, so they all fall
  back to the folder; synced workspaces carry real names.

### Wide layout: main on the left, overflow on the right (2026-10-13)

Every view lives in the **project (content) column at every width**; the detail column
holds the view's *overflow* on wide windows (`overviewSplit`, `emptyDetail` in
`ProjectsSplitView`). Switching view is therefore an in-place change in any layout (an
earlier attempt put Board/Calendar in the detail column to give them room; folded, that
made a view switch a column push — a page swipe — and was dropped).

| View | Left (project column) | Right (detail column) until an item is open |
|---|---|---|
| Overview | masthead, focus, KPI strip, attention queue, task flow, open-by-priority, health radar (`OVERVIEW_STATUS`) | recent notes + activity log (`OVERVIEW_DETAIL`) |
| Notes | list | note |
| Board | the board (view switcher on top) | status blocks: KPI strip, task flow, open-by-priority |
| Calendar | month/week grid, overdue banner and the Unscheduled tray | `CalendarDayPanel`: KPI strip (today / week / month / overdue, `lib/project-status.ts`) and the selected day's tasks |

- Opening a task or note replaces the overflow panel; ✕ brings it back. Collapsed, the detail
  column only appears with an open item (Back returns), and the Calendar's grid column shows
  its own day list again (`externalDayList` is off when `compact`).
- The Calendar keeps the grid and the Unscheduled tray together so drag-to-reschedule still
  works inside one view; the selected day is shared with the detail panel
  (`calSelected`), and a reschedule bumps `calVersion` to refresh the panel.
- The Overview blocks are reusable (`OverviewTab` `show`, `OverviewPanel` loads the data), which
  is how the Board gets its status. Long card subtitles wrap instead of overflowing.
- Native collapse: `forceCompactBelow(700)` (`swiftui-modifiers`) lets SwiftUI measure its own width and force compact below 700pt in the same layout pass; the old JS-driven `forceCompactWidth(compact)` left the split view forced compact for a beat after unfolding. The Overview's detail column is always the Recent panel (not a compact-only placeholder) for the same reason: on unfold SwiftUI expands before JS knows the width. Needs a native rebuild.
- `useHingeStatus() === "closed"` flips `compact` early (the hinge reports before the window
  shrinks).
- **No project selected** (a wide window on the project list, or after re-tapping the Projects tab): the sidebar opens (`columnVisibility="all"`, our own value is never kept as the user's choice) and the detail column says "No project selected" (the project column is blank: the overlay sidebar covers it). Choosing a project hides the sidebar again. A plain unfold no longer jumps into the first project.

### Fold/unfold transitions: causes and rules (2026-10-13)

Apple's Duo docs say nothing about how a layout change should *animate*: they say use system
containers, key layout to size classes / scene bounds (not screen size or orientation), and switch
a variant by changing a value rather than rebuilding the hierarchy. Everything below was found by
watching the simulator. A fold/unfold is two events a beat apart — SwiftUI collapses/expands the
split view with the window, then React Native learns the new width — and every flash was our JS
state catching up. The rules that came out of it:

1. **Same structure, same keys, same props at every width.** Anything keyed on `compact` that
   changes what a column *contains* flashes on the beat in between. (Board/Calendar in the
   detail column when wide and the project column when folded remounted on every fold; the
   Overview's compact-only "Nothing open" placeholder showed for a frame on unfold.) Where a
   width-dependent variant is unavoidable it must be cheap: the Overview trims to its status
   blocks and the Calendar moves its day list out (`externalDayList`).
2. **Let SwiftUI decide the collapse.** `forceCompactBelow(700)` replaces the JS-flag modifier;
   `columnVisibility` is a constant (it switched `automatic` → `doubleColumn` once JS caught up,
   so the sidebar opened with the unfold and then slid away). `useHingeStatus() === "closed"` is
   used as an *earlier* compact signal when folding (the hinge reports before the window shrinks).
3. **A view switch must not change the compact column.** Folded, SwiftUI turns a switch between
   views that live in different columns into a push (page swipe) and a Back — and the animation
   can't be disabled (`@expo/ui` `animation` has no "none"; the slide is UIKit's). So every view
   lives in the project column and only the *overflow* is in the detail column.
4. **Read local data synchronously on first render.** `ProjectScreen` and `ProjectCalendarScreen`
   seed their state from the SQLite reads (`useState(() => …)`) — loading in an effect gave a
   "No board columns" frame and a title that settled.
5. **Don't invent a selection.** The wide layout used to show the first project when none was
   picked; folding then landed on the project list ("no continuity") and recording it on unfold made
   a plain unfold jump into a project. Now no selection ⇒ sidebar open + "No project selected" in
   the detail column (the project column is blank: the overlay sidebar covers it). Re-tapping the
   Projects tab resets to this state (`tabPress` → `resetProjectsSelection`).

Tried and dropped: Board/Calendar in the detail column with a status panel in the project column
(roomy when wide, but a push when folded); a nested project → view tree in the sidebar (extra Back
to change view); `ArrangementView` for the split (see "ArrangementView spiked and killed").
If a flash remains, the next tool is a short Reanimated crossfade over the width-dependent swaps
(rule 1's cheap variants), not more state.

### Other decisions from this pass (2026-10-13)
- **Side-inset padding** — `useEdgePad(base)` (`src/lib/use-edge-pad.ts`): the page padding on a
  side that has a system inset shrinks to 10pt (the inset is already the margin); the other side
  keeps `base`. Used by AI settings, Appearance, Tools, Providers, Usage, Sync, Conflicts, Restore.
  The inset itself is the system's (`R84` on the outer display), never a number we set. Pickers /
  composers (parked cards) and tab screens (inset by `TabStack`) don't use it.
- **Filled previews** (`useSidePreview`): when the preview pane fills the window it spans both
  edges and handles the side rail itself, so the RN wrapper must not also pad the left
  (`paddingLeft: fills ? 0 : insets.left`) — the double inset clipped the page in the left
  Split View window.
- **Measure, don't guess widths**: the usage chart (AI settings) sizes to its card via `onLayout`
  instead of `window − 48`, which ignored card/page padding and the side rail.
- **Overview as a set of blocks**: `OverviewTab` takes `show` (a list of `OverviewSection`s) and
  `header`; `OverviewPanel` loads the data for a block set. Wide Overview = `OVERVIEW_STATUS` left,
  `OVERVIEW_DETAIL` right; the Board's status panel reuses `kpi / flow / priority`.
- **Titles**: the split-view Calendar header is just the project name (the switcher already says
  Calendar); the standalone Calendar route keeps `Project · Calendar`.

### Split View on the Duo (test pass 2026-10-12)

The simulator's Split View is half-screen only: Cairn's window is **469×669** (or the
full 951×669). The divider doesn't free-resize — drags snap back to 469, or past a
limit hand Cairn the whole display. Measured with the Fold overlay and `lldb`
(`recursiveDescription` on the live window — see "Debugging aids"):

- Projects, notes, Chat and Calendar all lay out in the 469pt window (below the 700pt
  `forceCompactWidth` cut, so Projects drills down; previews that open from Chat /
  Calendar / Graph / Overview **fill** the window since 469 < `SIDE_PREVIEW_MIN_WIDTH`).
- The side rail sits on the **left** of the left window (right of the right window).
  The window reports `L0 R0` safe-area insets there, while a screen's own
  `useSafeAreaInsets()` reports `left: 84` and the screens' `RNSSafeAreaView` wrapper
  is laid out at x=84 (385pt wide).
- **Bug (fixed): filled previews clipped in the left window.** Opening a task or note
  from Chat / Calendar / Graph / Overview in the 469pt window drew the page ~84pt too
  far right and ran it off the edge (Title field, Urgent chip cut off). Cause: with a
  preview open, `useSidePreview`'s `contentStyle` kept `paddingLeft: insets.left`
  (right padding was already dropped because the SwiftUI pane handles the rail), but
  a *filled* pane spans both edges and handles the left rail too — so the RN wrapper
  inset it once (385pt container at x=84) and the SwiftUI `Host`/`NavigationStack`
  inside inset the content again (hosting view 469pt wide, content placed at +84).
  Fix: `paddingLeft: fills ? 0 : insets.left`. Notes opened inside the Projects tab
  were fine in the same window (they aren't hosted in a `SidePreview` pane).
- Not covered: the app in the right-hand window (rail on the right; same code path
  as full screen), modals in the split. If a bug like this resurfaces, the view
  hierarchy dump is the fastest way to see which layer adds the extra inset:
  `lldb -p <pid> --batch -o 'expr -l objc -O -- [[[[[[UIApplication sharedApplication]
  connectedScenes] anyObject] windows] firstObject] recursiveDescription]'` (cast
  `NSStringFromX` calls to `(NSString*)` when building strings; no variadic
  `appendFormat`).

### Projects in a narrow regular-width window (portrait Duo, ~669pt)

Regular width but too narrow for three columns: SwiftUI kept only the detail and hid
the project view behind the sidebar button (open it once and it shows as a scrimmed
overlay over the detail). `forceCompactBelow(700)` (local `swiftui-modifiers`, originally the
JS-flag `forceCompactWidth(compact)`; `.environment(\.horizontalSizeClass, .compact)`) makes the
split view collapse for real below 700pt, so the portrait Duo drills project list → view → item with a native Back,
like the folded Duo. It changes only an environment value, so nothing remounts.
Needs a native rebuild.

### Composer behind the tab bar after rotating (pre-existing, fixed)

Bisected against the pre-fold commit: rotating the unfolded Duo from landscape to
portrait left the chat composer resting ~8pt above the bottom edge — behind the tab
bar — until the screen was left and re-entered. `KeyboardStickyView` interpolates its
offset by the keyboard `progress`, which can be stuck at 1 after a rotation while the
height is 0, so it applied the *opened* offset (`KEYBOARD_OPEN_GAP`) to a closed
keyboard. `RestingStickyView` (`src/components/chat/RestingStickyView.tsx`) treats a
zero keyboard height as closed regardless of `progress`; while the keyboard moves the
height is non-zero and the library's progress is used as before. Search's scope bar
uses the same library view and may show the same symptom.

### Keyboard + SwiftUI hosts: who owns the keyboard (note editor toolbars)

Inside a `Host` (the Projects split view, the side-preview pane) SwiftUI also resizes
its columns for the keyboard, while `react-native-keyboard-controller`'s
`KeyboardStickyView` assumes the keyboard overlaps a full-height container and lifts
by the whole keyboard height — counted twice, so the editor's formatting/AI toolbars
ended up under the header (pre-existing, reproduced on the pre-PR commit). Rules now:
- Both hosts pass `ignoreSafeArea="keyboard"`; keyboard-controller owns the keyboard
  everywhere, as in Chat.
- `NoteEditorBody` renders the toolbar as an absolute overlay on a full-height wrapper
  inside a `RestingStickyView` (like the chat composer), and if the wrapper was
  already shrunk for the keyboard (detected from its own `onLayout`; `measureInWindow`
  is unreliable inside the hosting layer) it cancels the lift.
- Nested in Projects the container already stops above the tab bar / bottom safe
  area, so `bottomInset` is 0 there (it doubled the inset: an empty band under the
  formatting row). Full-window routes keep `insets.bottom`.
- The image button is the first item of the formatting row (reachable without
  scrolling).

### Debugging aids and tooling notes (2026-10-12 session)
- Settings → Appearance → Developer → **Fold overlay** (dev builds; `dev-flags.ts`,
  `FoldDebugOverlay`) — window/insets/hinge readout, the crease source (`fold=native` /
  `native:none` / `inferred`) and geometry (`h@476±20`), plus the crease band.
- Native view hierarchy: attach `lldb` to the app's pid and print
  `recursiveDescription` of the key window; walk up from a view with `superview`, comparing
  `frame` and `convertRect:toView:nil` per layer. That is how the double side-rail inset in
  filled previews was found (a layer adding the inset a second time shows as a frame at x=84 whose
  child is still full width). Cast `NSStringFromX(...)` to `(NSString*)`; no variadic `appendFormat`.
- Metro goes stale (edits not served, logs missing): restart it with `--clear` as a background
  task, then terminate/relaunch the app. Native module changes need `xcodebuild` +
  `simctl install` (`EXPO_USE_PRECOMPILED_MODULES=0`).
- The simulator's Split View is half-screen only (469pt windows) and the pose can't be scripted:
  fold / unfold / Split View are driven by hand in Device Hub; tap injection stops working after a
  long session — restart the app before suspecting a bug.
- Bisect against the pre-PR commit by checking it out (`git checkout --detach
  898c5d7f`) and cold-launching: it separated three pre-existing bugs (rotation
  composer, editor toolbars, Projects empty detail) from the fold work.
- A second simulator (`iPhone 17 Pro`) is the control for "is this a Duo problem?";
  it needs the dev client rebuilt for any native module changes
  (`EXPO_USE_PRECOMPILED_MODULES=0 npx expo run:ios --device <udid> --no-bundler`).
- Screenshots lag taps; take a second one before judging a state. Tap coordinates are
  device points (the screenshot's pixel width ÷ the device's point width).
- The hinge cache is fed by `expo-hinge` (no SwiftUI host needed; the old `HingeObserver` is gone).

## Unifying — getting rid of the native additions

Goal: one model for "pick project → view → item" on every wide device, with as
little native code as possible.

### What's already shared
- The selection store, the views list (`VIEWS`), the column chrome
  (`ScreenChrome` / `ChromeColumn`), and the tree sidebar column.
- The tree's *data* — projects × views — is the same everywhere; there is one
  renderer now (the sidebar column).

### Options

**A. One in-app tree everywhere (no `tab-sidebar` module) — DONE.**
The SwiftUI sidebar column serves iPad too; the system tab sidebar stays flat.
Zero UIKit surgery; identical behaviour on both devices. Cost: on iPad the app
has two sidebars (the system one for tabs, ours for projects) — less
Mail-like, but the column docks instead of overlaying.

**B. Upstream grouped tabs (removes `tab-sidebar`).**
Add `UITabGroup` / sidebar-only children to react-native-screens' tabs host and
expose them through expo-router `NativeTabs` (e.g. nested `NativeTabs.Trigger`s
or a `sidebarItems` prop with a selection callback). This is the "right" fix and
keeps the iPad fully native, but needs a react-native-screens change (its
controller is built on `setViewControllers`) and an expo-router API — weeks to
months of lead time, and it doesn't help the Duo (phone idiom).

**C. Upstream `navigationBarHidden` to @expo/ui (removes `swiftui-modifiers`).**
A one-modifier PR (`toolbarVisibility(_:for:)`). Small and likely welcome; until
then the local module is the supported extension mechanism, not a patch.

**D. Drop the header bridge on iPad by docking the system sidebar.**
When the iPad tab sidebar is visible (landscape) the floating pill disappears and
SwiftUI column bars sit at the top on their own — no bridge needed. Portrait still
has the pill, so the bridge stays unless we accept the band there.

### Recommendation
Keep the shared JS model and make the renderer the only per-device difference:

1. ✅ The project list lives in one hook (`useProjectsList`; it was a tree, `useProjectsTree`, until 2026-10-13), and since the
   panel deletion there is one renderer too (`ProjectsTreeSidebar`), so
   behaviour can't drift.
2. ✅ `tab-sidebar` sits behind a flag with **A** as the automatic fallback: if
   the module can't install (or a react-native-screens upgrade breaks it), the
   iPad gets the same panel as the Duo.
3. Pursue **C** now (small) and **B** opportunistically; delete the modules as the
   upstream APIs land.

## Session notes — 2026-10-11 (modal safe zones, inline composer, overview split)

What was decided and built while testing on the Duo simulator
(`npx expo run:ios`, iPhone Duo, `EXPO_USE_PRECOMPILED_MODULES=0` exported —
without it `onHingeChange` silently no-ops; the hinge status also reads `null`
until the first posture change after each reload, which is normal).

### Modal side-insets: measure, don't assume (`ModalSafeView`)

The tab rail reserves ~84pt on the unfolded Duo's right edge (`L=0 R=84` in
that posture). Tab screens clear it via `useTabContentStyle()`; native modals
needed the same — but a static inset is wrong in both directions:

- Full-window modals (AI settings, Sync) run under the rail without one.
- The *same route* presents as a parked card in another posture (e.g.
  Appearance centered/leading on the inner display), where window insets only
  squeeze the card. Placement is system-decided per posture, so no static
  per-route assignment survives.

`src/components/ModalSafeView.tsx` is the single rule: it measures its own
container (`onLayout`) against the window and pads only when the container
spans (nearly) the whole window. Unmeasured first frame assumes fullscreen
(the clipping case); cards correct on layout. It must be the outermost
`flex:1` view. Applied to the AI/Sync/Tools/Appearance/Usage/Card modals;
those routes use the unpadded `cardStyle` contentStyle so insets apply exactly
once. Pushed detail routes keep the navigator-level padding (always
fullscreen); `(tabs)` keeps none (TabStack owns it — double-padding guard).
Phone/folded postures have zero insets, so everything is a no-op there.

### New-note goes inline on wide layouts (`NoteComposer`)

Tapping `+` pushed the `note/new` modal, which parks on the left page — and
iOS exposes no sheet-placement API to move it (`preferredPlacement` is not
surfaced by expo-router; verified all `presentation` modes). So the composer
lives in the detail column instead: `NoteComposer` renders its title + Save
through `ScreenChrome`, which draws in the native header as a route and in
the column bar in a split view — one component, both hosts. The `note/new`
route is now a thin wrapper (phone keeps the modal). A `composing` flag on
the split-view selection drives it; any navigation clears it. While a note is
open the note bar also drops the list's `+` (mirrored on the board, which
drops its `+` while a task is open on the Duo).

### Tree sidebar owns workspace actions (panel deleted)

The narrow Projects header (sync badge + settings) never renders in split
mode, stranding both. They moved into the sidebar's native column bar
(`Projects` title, leading workspace-switcher menu, trailing sync/settings
icon buttons) — first as a hand-rolled row (which wrapped at narrow widths),
then as a real `Toolbar`, the same pattern the content columns use. The
slide-over `ProjectsTreePanel` and its folder button are deleted: the sidebar
column is the projects entry in every posture (permanent column when wide,
the collapsed column when compact, reached via the native sidebar toggle when
the system hides it for room).

### ArrangementView spiked and killed

Tried `ArrangementView` (split, horizontal) for Notes list|note. Findings
from `onGeometryChange` frame logs, both branches half-folded:

- Identical native frames: `[0,456]` / `[496,868]` — hinge-centred with ~20pt
  crease gutters from SwiftUI itself.
- `ChromeColumn` toolbars only draw inside a navigation container; bare
  columns lose all bars, and per-side `NavigationStack`s reintroduce insets.
- Verdict: no geometric advantage; the split view stays. Note left in code.

### Overview measures its container (`OverviewTab`)

First cut split the nine sections at the window middle (mirroring
`SPLIT_MIN_WIDTH`) — correct when Overview owned the whole window, broken once
it moved into the Content column (window-sized columns overflowed and clipped
inside it). It now measures its own container (`onLayout`): two even columns
at ≥600pt, one stack below (single stack on the first frame until measured).
Yoga lessons, both still load-bearing:

1. Subtract the scroll-content padding from the measured width (forgetting it
   both offsets the break and clips the right column).
2. Bare `width` loses to `flex:1`'s zero flex-basis, and the `flexBasis:
   "auto"` string form measured zero — pin columns with matching
   `width`/`minWidth`/`maxWidth` and no flex keys.

### Debugging on the Duo simulator

Fast, reliable loop used throughout: Metro serves this repo directly, so edits
apply on save; navigator-structure changes need a full `r` reload (Fast
Refresh leaves phantom shifted layouts). Temporary red-line/readout overlays
and `onGeometryChange` frame logs (`[duo-debug]`) settle "where is it really"
arguments — all removed before committing. `xcrun simctl io booted screenshot`
captures the simulator without interrupting the session. The LogBox banner in
screenshots is pre-existing noise (DrawerLayoutAndroid deprecation +
Reanimated web-deps warning on chat). Dual-display capture: once unfolded, the
default framebuffer is the dark outer display — capture the inner display by
UUID (`simctl io booted enumerate` lists the ports).

### Single adaptive container (continuity spike)

One `NavigationSplitView` always mounted on iOS (Sidebar = tree, Content =
view, Detail = item-or-action-panel), collapsing via `preferredCompactColumn`
(the collapsed column follows the selection depth; the native Back pops the
selection). Fold/unfold morphs instead of remounting — verified with a note
open, in both directions. Supporting rules, all learned the hard way:

- Opening an item never switches the view (`openNote`/`openCard` only set the
  item id); the item renders in Detail whatever Content shows.
- Detail is always mounted (the slot stays reserved when empty); with nothing
  open it hosts a per-view `DetailActionPanel` (New note / New task /
  View board).
- No column width pins of any kind (see the hinge note).
- One dismiss per posture: the column ✕ only when expanded (collapsed has
  Back); while editing, the editor's Cancel replaces it (see the Apple Duo
  audit below — this superseded "Cancel in route mode only").
- `simctl terminate` does not reliably restart the app; after structural
  native changes reboot the simulator (`shutdown`/`boot`), and confirm the new
  code is actually running (temporary marker, or curl the Metro bundle and
  grep for a new string) — stale bundles get served silently.

## Apple Duo audit — 2026-10-11

Checked against the HIG ([Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo))
and [Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo).

### Already aligned
- **Continuity (Mail pattern).** One always-mounted split view: folded shows
  one level, unfolded shows two/three; selection survives remounts.
- **System containers, no width pins** — Apple: split views adapt to the fold
  themselves. ArrangementView rejected for the reasons in the session notes
  (and "keep navigation outside arrangement views").
- **Bar axis.** Sidebar/content bars horizontal, detail bar vertical (system).
- **Container-relative sizing** (`OverviewTab`, `ModalSafeView`); even column
  counts on the Overview.

### Side rail rules (implemented in `ChromeColumn`)
Apple orders the vertical bar top → bottom: Back/Close, the prominent action,
then the rest; items overflow bottom-up by `visibilityPriority`.

| Item | Placement / priority | Why |
|---|---|---|
| Column ✕ (`leading` key `close`) | `cancellationAction` | top of the rail |
| Screen Cancel (`CANCEL_KEY`) | `cancellationAction`, replaces the column ✕ | one dismiss |
| `variant: "done"` (Save) | `confirmationAction`, priority high | prominent, kept longest. `topBarPinnedTrailing` was tried: it landed *above* Close and lost the prominent style |
| `kind: "menu", overflow: true` (note/task actions) | each action → `secondaryAction` | the system overflow menu; Apple reserves the ellipsis for it |
| List / board + (`priority: "high"`) | high | "Preserve frequently used actions first" (Compose) |
| Sidebar sync / appearance | high / low | status stays visible; settings overflow first |

Text-only items never dock vertically, so every column item needs a symbol
(Calendar's Today got one; the span menu dropped its visible text).

**One dismiss per posture.** Folded, the collapsed split view shows Back, which
pops to the same place as the column ✕ — so `ProjectsSplitView.dismiss()`
omits the ✕ when compact. Unfolded the detail column has no Back, so ✕ stays.
While editing a note, the editor's Cancel (revert, stay) replaces the ✕.

Resulting rails (folded): task — Back · Save · ⋯; note — Back · Edit · ⋯;
note editing — Back · Cancel · Save; board/list — Back · +; calendar — Back ·
Today · span.

### Fixed in the audit
- **Notes list + vanished when folded.** The Duo bridge moved the list's items
  into the note column's bar, which isn't on screen folded. The list is now
  bridged only when unfolded with a note open.
- **Chat preview lost on fold.** `ChatPreviewPane` stays mounted; folded with a
  preview open it fills the window (`fill`), the chat collapses beside it
  (still mounted). ✕ returns to the chat. While any preview is open the
  chat's own toolbar (clear / AI settings) is unmounted — mounting
  `Stack.Toolbar` keeps the stack header up even with `headerShown: false`,
  and its items stacked a second button column beside the preview's bar.
- **Chat preview at every width.** Chips always open the pane (never a pushed
  route): folded it fills the window, unfolded it sits beside the chat, so
  fold/unfold moves the same preview. While it's open the chat screen drops
  its right rail padding (`contentStyle`) so the pane's SwiftUI host reaches
  the window edge and its bar joins the tab rail — with the RN padding the
  bar stood as a second column beside the rail (inset applied twice).
- **New task was a modal** (parks on the left page unfolded). `TaskComposer`
  is shared by the `card/new` route and the detail column (`composing:
  { task, column? }` in the selection), like `NoteComposer`.
- Workspace switcher used `folder` (same as the Projects tab and project
  rows) → `square.stack.3d.up`.

### Still open after the Duo pose / Split View work
(Checked and not affected: Search's scope bar is UIKit's native search scope — or a
measured inset — not a `KeyboardStickyView`, so the composer's rotation bug can't occur.)
- ✅ Native `ReservedRegion` crease (`modules/fold-region`), verified on the Duo simulator
  (2026-10-12), overlay readout in brackets: closed [`native:none`], laptop [`h@476±20`, 40pt
  gutter, not the 20pt the inference assumed], book [`v@476±20`], flat [`native:none`], and
  Split View (469pt window left of the crease) flat [`native:none`] / half-folded [`v@462±7`, a
  14pt sliver at the window's edge; the inference would have put it at mid-window].
- ✅ Projects navigation (flat list + switcher), wide overflow panels, no-project state, fold/unfold
  flash fixes, side-inset padding (this file, 2026-10-13).
- **Not verified**: iPad (the bridged-header path; `BRIDGE_HEADER` keeps the stack-header
  buttons, nothing was run there); the book pose and the 669pt portrait unfold after the native
  `forceCompactBelow` change; modals inside a Split View window; the Android fallbacks for
  `fold-region`; a physical Duo (the inset and crease numbers come from the simulator profile).
- The board in the 330pt project column is narrow (it scrolls sideways); if that is a problem the
  alternative is the board on the right with the status on the left — but that is the
  detail-column structure rule 3 rules out folded.
- Calendar rail buttons (Today, Month/Week) stay in the column bar; the unfolded Calendar header is
  the project name only.
- Possible polish: a crossfade over the width-dependent content swaps; thin the usage chart's x
  labels on narrow cards.

### Still open (need native modifiers in `modules/swiftui-modifiers`)
- Hide Back while editing (`navigationBarBackButtonHidden`) — standard iOS
  edit mode shows only Cancel / Done.
- `toolbarVerticalCompressionBehavior` — minimise the tab bar in editors
  (task-oriented views) so their actions keep the rail.
- `presentationPlacement` for sheets; `reservedRegions` / `toolbarVerticalEdge`
  for custom layouts (the chat preview still sizes from the hinge status).
- Layout decisions still key off `Platform.isPad` (`BRIDGE_HEADER`) and a 700pt
  width cut; Apple prefers size classes. Harmless today, wrong for iPad
  Split View at compact width.

