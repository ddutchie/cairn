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

### Picking a project and view
The same tree on both wide devices — projects that expand to Overview / Notes /
Board / Calendar, like Mail's accounts and mailboxes:

- **iPad** — the system tab sidebar (`modules/tab-sidebar`, see below). Picking a
  row from any tab opens Projects on it; the open view is highlighted.
- **Duo** — `ProjectsTreePanel`: a SwiftUI sidebar list in a panel that slides
  over the left page and ends on the hinge. Opened by the folder button in each
  column's bar.

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

1. Extract the tree data (`projects × VIEWS`, selected path, `onSelect`) into one
   hook used by both the iPad sidebar and the Duo panel — so behaviour can't
   drift.
2. Keep `tab-sidebar` behind a feature flag with **A** as the fallback: if the
   module fails to install (or a react-native-screens upgrade breaks it), the
   iPad falls back to the same panel as the Duo. That makes the native piece an
   enhancement rather than a dependency.
3. Pursue **C** now (small) and **B** opportunistically; delete the modules as the
   upstream APIs land.
