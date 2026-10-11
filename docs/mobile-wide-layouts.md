# Mobile wide layouts — iPad & iPhone Duo

How Cairn Mobile lays out Projects (and the Chat preview) on wide windows: the
unfolded iPhone Duo and the iPad. Spike branch `spike/duo-split-view`.

## Devices and what differs

| | Phone (folded Duo, iPhone) | iPhone Duo, unfolded | iPad |
|---|---|---|---|
| Window | < 700pt | ~951 × 669pt, hinge at ½ | 1032pt+ |
| UI idiom | phone | **phone** | pad |
| Tab bar | bottom bar | **side rail** (84pt right inset) | **floating pill** in the top row |
| System tab sidebar | no | **no** (idiom gate, see below) | yes (`sidebarAdaptable`) |
| Projects layout | stack (routes) | split view | split view |
| Project / view picker | segment + routes | slide-over tree panel | system tab sidebar |
| Column buttons | stack header | each column's SwiftUI bar | stack header (shares the pill's row) |

`SPLIT_MIN_WIDTH = 700` (`app/(tabs)/projects/index.tsx`) switches between the
phone stack and the split view, live on fold/unfold.

## Component map

```
app/(tabs)/projects/index.tsx      width ≥ 700 → <ProjectsSplitView>
└─ ProjectsSplitView               selection store, layout choice, header (iPad)
   ├─ Notes view:   Host ▸ NavigationSplitView (balanced)
   │                  Sidebar: ChromeColumn ▸ ProjectScreen (notes list)
   │                  Detail:  ChromeColumn ▸ NoteDetailScreen | empty state
   ├─ Other views:  Host ▸ NavigationStack ▸ ChromeColumn ▸ Overview | Board | Calendar
   │                  Board: row of [board | ChatPreviewPane (task panel)]
   └─ Duo only:     ProjectsTreePanel (slide-over, absolutely positioned)

app/(tabs)/chat/index.tsx          width ≥ 700 → ChatPreviewPane beside the chat
```

### Selection
A module-level store in `ProjectsSplitView` (`{ projectId, view, noteId, cardId }`
via `useSyncExternalStore`). It lives outside React so it survives the split view
unmounting when the Duo folds and remounting when it unfolds.

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
- **iPad** — the stack header in the tab bar's row: the folder (panel mode) first
  on the left, then the list's / board's items; the open note's or the view's
  own items (Overview, Calendar) right of the tab bar.
- **Duo** — the bar that docks into the side rail. Full-width views use their
  own column's bar; on Notes the list keeps only its title and its items (+)
  move, with the folder, to the note column's bar, so every view puts its
  buttons in the rail.

### Picking a project and view
The same tree on both wide devices — projects that expand to Overview / Notes /
Board / Calendar, like Mail's accounts and mailboxes. One model,
`useProjectsTree` (`src/components/projects-tree.ts`: nodes with count badges,
the selected path, `select(path)`), feeds two renderers:

- **iPad** — the system tab sidebar (`modules/tab-sidebar`, see below). Picking a
  row from any tab opens Projects on it; the open view is highlighted.
- **Duo** — `ProjectsTreePanel`: a SwiftUI sidebar list in a panel that slides
  over the left page and ends on the hinge. Opened by the folder button in each
  column's bar.

The system sidebar is a feature flag (`SYSTEM_SIDEBAR` in `ProjectsSplitView`)
and an enhancement, not a dependency: `setSidebarGroup` resolves `false` when it
can't install (not an iPad, iPadOS < 18, module missing, no tab controller
found), and the iPad then shows the same panel and folder button as the Duo.

### The open item
The note open beside the list is tinted in it (`NoteRowItem selected`), and the
task open beside the board is outlined on its card (`DraggableBoard
selectedCardId`) — both via `ProjectScreen selectedId`.

### Hinge (Duo)
`onHingeChange` (iOS 27.1 SDK) on the split / stack reports the posture; the last
value is cached in `src/lib/hinge.ts` so a remount starts in the right layout.
The left column and the tree panel are exactly half the window. Note:
`onHingeChange` is a no-op with precompiled Expo modules — builds need
`EXPO_USE_PRECOMPILED_MODULES=0` (release: `ios.usePrecompiledModules: false`
and an Xcode 27.1 EAS image).

### Task / note side panel — `ChatPreviewPane`
One animated width (Reanimated) slides a note or task in from the right, beside
the chat or the board, so neither remounts. Half open on a Duo it starts exactly
on the hinge.

## Native additions (what's not stock Expo)

Nothing in `node_modules` is patched. There are two local Expo modules:

### `modules/swiftui-modifiers` — `navigationBarHidden()`
Registers one custom @expo/ui modifier (`.toolbar(.hidden, for: .navigationBar)`)
via `ViewModifierRegistry`. Used by bridged columns on iPad. Tiny and stable —
it's @expo/ui's own extension point.

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
  mode reports regular width yet never draws a sidebar → the Duo's own panel.
- **SwiftUI split falls back to overlay** when sidebar + detail minimums don't fit
  the window (Duo: half the window + default detail minimum > 951pt − rail). Set
  the detail column's own minimum (`navigationSplitViewColumnWidth`) and use
  `navigationSplitViewStyle("balanced")`.
- **Controlled `columnVisibility`** only reaches SwiftUI when the prop changes.
  SwiftUI may collapse the list by itself on first layout and report
  `detailOnly`; answering with the same value we already pass does nothing —
  answer with a different "shown" value (`all` ↔ `doubleColumn`).
- **iPad leading header items** fold into a "⋯" overflow on a cold start when an
  item has a long text label → icon-only items.
- **Moving a hosted RN view between SwiftUI columns** renders blank → each layout
  has its own `Host` key.
- **Stack.Screen options persist** → the narrow header sets `headerShown` and
  `contentStyle` explicitly so the split view's overrides don't stick.

## Unifying — getting rid of the native additions

Goal: one model for "pick project → view → item" on every wide device, with as
little native code as possible.

### What's already shared
- The selection store, the views list (`VIEWS`), the column chrome
  (`ScreenChrome` / `ChromeColumn`), the side panel, and the full-width vs
  list | item rule (only Notes has a list).
- The tree's *data* — projects × views — is the same for the iPad sidebar and the
  Duo panel; only the renderer differs.

### Options

**A. One in-app tree everywhere (no `tab-sidebar` module).**
Use `ProjectsTreePanel` (or a SwiftUI sidebar column) on iPad too, and keep the
system tab sidebar flat. Zero UIKit surgery; identical behaviour on both devices.
Cost: on iPad the app has two sidebars (the system one for tabs, ours for
projects) — less Mail-like, and the panel overlays rather than docking.

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

1. ✅ The tree data lives in one hook (`useProjectsTree`) used by both the iPad
   sidebar and the Duo panel, so behaviour can't drift.
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
open the note bar also drops the list's `+` (same declutter rule the board
already uses for its panel-open `+`).

### Tree panel owns workspace actions

The narrow Projects header (sync badge + settings) never renders in split
mode, stranding both. They moved into the tree panel header (workspace title
+ sync + settings), reachable from every column via the folder button. The
sync tint logic mirrors `useSyncBadge` with lucide icons (its SF Symbols only
render in native toolbars). If `SYSTEM_SIDEBAR` is ever switched on, the panel
goes away on iPad and these need a home in the header bridge instead.

### ArrangementView spiked and killed

Tried `ArrangementView` (split, horizontal) for Notes list|note. Findings
from `onGeometryChange` frame logs, both branches half-folded:

- Identical native frames: `[0,456]` / `[496,868]` — hinge-centred with ~20pt
  crease gutters from SwiftUI itself.
- `ChromeColumn` toolbars only draw inside a navigation container; bare
  columns lose all bars, and per-side `NavigationStack`s reintroduce insets.
- Verdict: no geometric advantage; the split view stays. Note left in code.

### Overview splits at the hinge (`OverviewTab`)

Wide mode (`≥700pt`, mirroring `SPLIT_MIN_WIDTH`) renders the nine sections
as two columns — status through health left, notes + activity right. Two
Yoga lessons, both load-bearing:

1. Measure from the window middle, not the container: the container is
   already rail-inset, so symmetric flex lands ~40pt left of the hinge.
   Subtract scroll-content padding too (it offsets the break *and* clips the
   right column).
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
Reanimated web-deps warning on chat).
