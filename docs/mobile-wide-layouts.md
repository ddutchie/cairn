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
| Project / view picker | tree sidebar column | tree sidebar column (or its toggle) | tree sidebar column |
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
                                   Sidebar (tree) | Content (view) | Detail
                                   (open note/task, else a per-view action
                                   panel — the slot is always reserved)
   ├─ Sidebar:   ProjectsTreeSidebar (native bar: Projects title, leading
   │              workspace menu, trailing sync/settings icons + tree list)
   ├─ Content:   ChromeColumn ▸ ProjectScreen (notes list | board | overview
   │              | calendar)
   └─ Detail:    ChromeColumn ▸ NoteDetailScreen | NoteComposer |
                  CardDetailScreen | DetailActionPanel

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
The same tree on both wide devices — projects that expand to Overview / Notes /
Board / Calendar, like Mail's accounts and mailboxes. One model,
`useProjectsTree` (`src/components/projects-tree.ts`: nodes with count badges,
the selected path, `select(path)`), feeds two renderers (past and present):

- **iPad system tab sidebar** (`modules/tab-sidebar`, flag-gated, future) —
  picking a row from any tab opens Projects on it.
- **Split-view sidebar column** (`ProjectsTreeSidebar`, current) — the tree
  list under a native column bar: `Projects` title, leading workspace-switcher
  menu, trailing sync/settings icon buttons (the same `Toolbar` pattern the
  `ChromeColumn` content columns use). It is the projects entry in every
  posture: a permanent column when wide, the collapsed column when compact.
  The old slide-over `ProjectsTreePanel` (and its folder button) is deleted.

The system sidebar stays a feature flag in `modules/tab-sidebar` for a future
enhancement, not a dependency — the split-view sidebar column serves both
devices today.

### The open item
The note open beside the list is tinted in it (`NoteRowItem selected`), and the
task open beside the board is outlined on its card (`DraggableBoard
selectedCardId`) — both via `ProjectScreen selectedId`.

### Hinge (Duo)
`onHingeChange` (iOS 27.1 SDK) on the split view reports the posture; the last
value is cached in `src/lib/hinge.ts` for whoever needs it (currently only the
chat preview pane). Column widths are SwiftUI's job entirely — no pins: a
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

1. ✅ The tree data lives in one hook (`useProjectsTree`), and since the
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
- The note editor's Cancel ✕ shows in route mode only — in a column the
  column's own ✕ is the single dismiss (`useInColumn()`).
- `simctl terminate` does not reliably restart the app; after structural
  native changes reboot the simulator (`shutdown`/`boot`), and confirm the new
  code is actually running (temporary marker, or curl the Metro bundle and
  grep for a new string) — stale bundles get served silently.
