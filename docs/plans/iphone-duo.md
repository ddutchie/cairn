# iPhone Duo — device, OS behaviors & Cairn plan

Status: Split view merged; laptop pose (portrait half-fold), narrow-window Projects
drill-down and several keyboard/rotation fixes shipped in PR #223 (`feat/duo-poses`,
2026-10-12) — see `docs/mobile-wide-layouts.md` "Poses". Remaining: draft/focus
acceptance matrix (§5.0), Split View multitasking pass (§5.4), native `ReservedRegion`
(§5.7).
Date: 2026-10-11 (Duo launches Oct 23, 2026; pre-orders Oct 16)
Related: `docs/mobile-wide-layouts.md` (current split-view architecture),
`docs/plans/mobile-app-viability.md`, `mobile/changelogs/v0.1.10.md`

## Canonical Apple docs (start here)

- [Get ready for iPhone Duo](https://developer.apple.com/iphone-duo/) (hub)
- [Prepare — iPhone Duo](https://developer.apple.com/iphone-duo/prepare/) (SDK tiers + resizing checklist)
- [Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo.md) (canonical overview)
- [Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo) (HIG; raw markdown: `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/designing-for-iphone-duo.md`)
- Tech Talks: [Prepare your app for iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111461/) · [Strike a pose with adaptive layouts](https://developer.apple.com/videos/play/tech-talks/111463/)
- API: [`ArrangementView`](https://developer.apple.com/documentation/swiftui/arrangementview.md)

For agents: prefer the `.md` endpoints where available; several
`developer.apple.com` HTML pages require JavaScript.

## 1. The device (from Apple)

- **Form**: book-style foldable ("passport" shape, 1.41:1 aspect ratio shared by
  both displays so content scales continuously). 5.2 mm open (thinnest iPhone
  ever), 11.3 mm closed, 254 g, grade-5 titanium, IP68.
- **Displays**: 5.4″ outer (1398×2034, 460 ppi) + 7.6″ inner foldable
  (1878×2670, 430 ppi) with nano-texture finish. Both ProMotion / Always-On /
  3000 nits. Under-display FaceTime camera on the inner display.
- **Chip**: A20 Pro (2 nm), 12 GB RAM. Dual battery (~24 h mixed use).
- **Input**: Touch ID in the side button (no Face ID). **Apple Pencil (USB-C)
  supported on both displays later in 2026** — directly relevant to a notes app.
- **Price**: from $1,999 (256 GB) to $3,199 (2 TB).
- **Ships with iOS 27.1.**

Sources: [Apple Newsroom](https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-duo/),
[apple.com/iphone-duo](https://www.apple.com/iphone-duo/),
[MacRumors roundup](https://www.macrumors.com/roundup/iphone-duo/),
[Wikipedia](https://en.wikipedia.org/wiki/IPhone_Duo).

## 2. How iOS 27 / 27.1 behaves on Duo (from Apple Developer)

### 2.1 SDK tiers — what our build gets

| Build SDK | Duo behavior |
|---|---|
| pre-27 | Compat: app runs at a familiar iPhone size; content stops left of the status bar/camera |
| iOS 27 | Extends left of the status-bar area on the inner display |
| **iOS 27.1 (Xcode 27.1)** | **Full edge-to-edge**; navigation/toolbar/tab bars lay out **vertically below the status bar** |

Full-screen Duo support requires building with the **iOS 27.1 SDK** (Xcode 27.1).
Before shipping such a build, Apple requires content to adapt to bars becoming
vertical — which is exactly the side-rail work in §5.

Sources: [Prepare — iPhone Duo](https://developer.apple.com/iphone-duo/prepare/),
[Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo.md).

### 2.2 The new rules (all confirmed Apple guidance)

- **Size classes, not idiom/orientation.** Outer display behaves like any iPhone
  (compact width); **inner display is regular × regular** (sidebar-worthy). Never
  branch on `userInterfaceIdiom`, `UIDevice.orientation`,
  `interfaceOrientation`, or `UIScreen.main` (ambiguous on two displays,
  heading for deprecation). The inner display **ignores supported interface
  orientations**.
- **Vertical bars are the norm.** Tab bars, nav bars and toolbars present
  vertically beside the status bar. Sheets: vertical bars on the outer display
  by default; on the inner display, horizontal for centered/leading placements,
  vertical for trailing (`toolbarVerticalBehavior` /
  `preferredVerticalBarBehavior`, `presentationPlacement`). Query verticality via
  `toolbarVerticalEdge` / `verticalBarEdge`.
- **Postures**: closed, open, tent, half-folded (flex), StandBy. Content reacts
  to folds, reorients, and hands off outer → inner seamlessly.
- **Split View multitasking**: the app can be dragged to either side; runs
  beside another app **or a second window of itself** ("saveable app pairs").
  Vertical system buttons may appear on **either** side — test both.
- **Safe areas are asymmetric.** Handle each side independently; never mirror
  one side's inset (`safeAreaInsets.left * 2`-style math breaks). Foreground
  controls inside the safe area, backgrounds may bleed edge-to-edge.
- **System containers adapt for free**: `NavigationSplitView` /
  `UISplitViewController`, `TabView` / `UITabBarController`, sheets, popovers,
  alerts all collapse (closed) ↔ tile/overlay (open) with no extra code.

### 2.3 The six Duo-only APIs (iOS 27.1)

From the Tech Talks + MacObserver summary:

| API | What it does | Cairn relevance |
|---|---|---|
| `ArrangementView` / `UIArrangementViewController` (split/overlay) | Primary + secondary views laid out across the fold | Killed for navigational list\|note (spike: identical frames + nav-inside-arrangement is contrary to Apple); reserved for layout-only pairs inside one navigation container |
| `ReservedRegion` / `UIViewReservedRegion` (division/occlusion) | Query hinge + camera regions; place custom UI outside the safe area without colliding | Custom bars, edge-to-edge canvases (graph?) |
| `onHingeChange` / `UIHingeInteraction` | Hinge status (closed/partially/fully open) + continuous angle — **for effects, not layout** | Feeds the shared hinge cache only; column widths are SwiftUI-owned, unpinned |
| `UIWindowSceneActivation` | **Second window of the same app — first iPhone that can do this** (inner display only) | Note in one window + list/chat in another; needs a native module (not in Expo, see §3) |
| `CameraCaptureAccessory` / `.sceneAccessory()` | Extra UI (teleprompter, subject preview) on the outer display during a camera session | None (no camera features) |
| Virtual Front Camera | Auto handoff outer ↔ under-display camera | None |

Sources: [Tech Talk: Prepare your app](https://developer.apple.com/videos/play/tech-talks/111461/),
[Strike a pose with adaptive layouts](https://developer.apple.com/videos/play/tech-talks/111463/),
[Leverage multiple displays and scenes](https://daily.dev/posts/leverage-multiple-displays-and-scenes-on-iphone-duo-apple-hzw8pvyys)
(via Apple Developer), [six new APIs summary](https://www.macobserver.com/news/iphone-duo-new-apis-developers-have-not-used-before/),
[HIG: Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo).

### 2.4 Testing

- **iPhone Duo simulator in Xcode 27.1 + Device Hub** (open/close/rotate/fold
  controls) — "the best way to test the full native experience".
- Resizable iPhone Mirroring on macOS 27 (extreme sizes both directions).
- **App Resizability skill** in Xcode 27.1 ("get my app ready for iPhone Duo"):
  scans for hardcoded sizes, idiom/orientation branches, `UIScreen.main`.
  Worth running against our native modules + any layout math.

## 3. Expo 58 inventory (verified against installed `@expo/ui@58.0.15`)

### Already available to us

- ✅ `ArrangementView` (+ Primary/Secondary, `arrangementViewStyle('split'|'overlay')`,
  `splitArrangementLayoutRatio`) — iOS 27.1+, children render without a
  container below 27.1 (graceful fallback).
- ✅ `onHingeChange` (+ `HingeStatus`) — feeds the shared hinge cache
  (`src/lib/hinge.ts`); column widths are SwiftUI-owned, unpinned.
- ✅ `NavigationSplitView` 2- and 3-column + `balanced` style — our Projects layout.
- ✅ `NativeTabs` `sidebarAdaptable` — the side rail itself.
- ✅ `onGeometryChange` with global position, `RNHostView matchContents`.

### Not exposed by Expo (candidate local modules — we have precedent)

- ❌ `ReservedRegion` query (SwiftUI + UIKit).
- ❌ `toolbarVerticalBehavior` / `verticalBarEdge`.
- ❌ `UIWindowSceneActivation` (second window).
- ❌ `.defaultTabBarPlacement(.sidebar)` (only `sidebarAdaptable` style).
- ❌ `presentationPlacement` for sheets.

Precedent: `modules/swiftui-modifiers` (`navigationBarHidden`) and
`modules/tab-sidebar` are already local modules; a `duo-*` module for the
missing modifiers would follow the same pattern (see
`docs/mobile-wide-layouts.md` §"Unifying"). But note the gotcha already
documented there: **`onHingeChange` is a no-op with precompiled Expo modules —
builds need `EXPO_USE_PRECOMPILED_MODULES=0`**.

## 4. Where Cairn stands ( maps to `docs/mobile-wide-layouts.md`)

Already done on this branch:

- One adaptive container: a single `NavigationSplitView` (Sidebar = tree,
  Content = view, Detail = open note/task or a per-view action panel) always
  mounted on iOS, collapsing to one column when compact via
  `preferredCompactColumn` — no width-switched subtrees, no `Host`-key swaps,
  no column width pins of any kind (`balanced` centres the break itself).
- Side-rail safe zones: tab screens via `useTabContentStyle()`, modals via the
  root navigator (`mobile/app/_layout.tsx`); headers blend to page colour
  beside the rail.
- Selection store + `preferredCompactColumn` carry the hierarchy across
  fold/unfold; opening an item never switches the view; the native Back feeds
  back into the selection.
- Per-column SwiftUI bars whose buttons dock into the rail (sidebar: `Projects`
  title, leading workspace menu, trailing sync/settings).
- Overview measures its container (two columns ≥600pt, stack below).

## 5. Gaps & next steps (ranked)

### 5.0 Continuity across unfold/fold — new top priority, outranks all below

Apple's Duo model is one running app morphing across displays (Mail pattern:
list-or-email closed, both side-by-side open), with the app responsible for
keeping functionality and state the same.

Direction (✅ SPIKED 2026-10-11, verified on the Duo simulator): **one adaptive
Projects container** — a single `NavigationSplitView` always mounted for the
Projects hierarchy (Sidebar = tree, Content = view, Detail = open item), letting
the system collapse it when compact. Expo's `NavigationSplitView` DOES collapse
(`preferredCompactColumn` + `onPreferredCompactColumnChange` both work); the
collapsed column follows the selection depth and the native Back pops the
selection. Verified on the simulator: folded drill-down lands on the right
column with a native Back; unfolding with a note open keeps the note open (no
remount, no route push); portrait-unfolded is too narrow for three columns so
the system hides the sidebar with its own toggle; landscape board verified
spanning poses with its action panel. Not yet verified: notes list|detail
hinge-centring after pin removal, draft/focus survival across the trip.
The width-switched subtree swap and the `Host`-key swap are removed.

Hard lessons that constrain all future Duo work (see `mobile-wide-layouts.md`
gotchas): SwiftUI reserves the Detail slot even when its child is null, so
Detail always hosts something (open item, else a per-view action panel) —
unmounting it only trades the panel for a blank page. And no width pins:
fixed numbers freeze a pose, `{ min, ideal }` ideals still missed the crease
across poses — the unpinned board reflowed correctly everywhere first.

Remaining (acceptance matrix, real task in progress): draft/focus survival
across the trip (edit + type + fold); keyboard open; sheet open/return; 50/50
Split View resize; delete-selected-from-elsewhere resolves; screenshot each pose.

1. **Build config for the 27.1 SDK (required before launch).** ✅ DONE
   2026-10-11: `eas.json` pins `macos-tahoe-26.6-xcode-27.1` (Xcode 27.1 RC)
   on both `production` and `preview` iOS profiles, and both set
   `EXPO_USE_PRECOMPILED_MODULES=0` (precompiled Expo modules would make
   `onHingeChange` and any future Duo API silently no-op). Still to verify on
   the simulator: hinge callbacks fire in a release/simulator build. Caveats:
   the image is still an RC — re-pin to the final 27.1 image when Expo
   publishes it; local runs need `EXPO_USE_PRECOMPILED_MODULES=0` exported in
   the shell too (`expo run:ios` / prebuild).
2. **Adopt `ArrangementView` for list | note.** ❌ SPIKED THEN KILLED
   2026-10-11: a `USE_ARRANGEMENT` flag rendered the Notes pair in a native
   split arrangement (each side in its own `NavigationStack`, since
   `ChromeColumn` toolbars only draw inside a navigation container — without
   one all bars vanish). Simulator frame logs (`onGeometryChange`) showed
   **byte-identical columns in both branches** half-folded (`[0,456]` /
   `[496,867]`, hinge-centred with ~20pt crease gutters from SwiftUI itself),
   and the per-side stacks reintroduced the insets the spike was meant to
   remove. Verdict: no advantage; the `NavigationSplitView` stays. Correction
   from further Apple research: the spike also inverted Apple's containment —
   Apple puts `ArrangementView` *inside* a `NavigationStack` and says to keep
   navigation containers *outside* arrangements, never split views inside them.
   Our spike put per-side `NavigationStack`s *inside* the arrangement. So the
   kill stands for navigational list|note, and any future `ArrangementView`
   use is layout-only pairs inside one navigation container — never a
   navigation replacement. All spike
   + debug code removed, verdict noted in `ProjectsSplitView`.
3. **Audit for symmetry + main-screen assumptions.** ✅ AUDITED, no changes
   needed (2026-10-11): every `useWindowDimensions` call reads the live window
   (fold-safe); left/right insets are consumed independently everywhere
   (`useTabContentStyle`, root navigator, `ChatPreview`); no hardcoded device
   sizes, no `Dimensions` API, no mirrored-inset (`* 2`) math. The single
   `Platform.isPad` branch (`BRIDGE_HEADER`) selects which *system chrome* to
   integrate with (floating pill vs side rail), not a layout by idiom, and
   expo-router exposes no placement signal to key off instead — leave it.
   Remaining: run Xcode's **App Resizability** skill over the target.
4. **Split View multitasking test pass.** Drag the app to each side on the
   inner display; vertical system buttons can appear left or right. Confirm
   columns, sidebar, modals and the chat preview survive narrowed widths —
   the split collapses to one column (no phone-stack swap anymore); verify
   that transition, especially around compact widths in 50/50.
5. **Second window (later).** `UIWindowSceneActivation` would let a note live
   beside its list as a real second window (better than our in-app preview
   panel for multitaskers). Needs a local module; inner-display-only. Defer
   until (1)–(4) are solid.
6. **Apple Pencil sketching in notes (later in 2026, when Pencil support
   ships).** Community Expo modules exist (`expo-drawing` = PencilKit + Android
   Ink cross-platform; `expo-pencilkit-ui`, `react-native-pencilkit` =
   iOS-only). Open questions for us: where a sketch lives in the data model
   (attachment? note block?), how it syncs (binary blob via the sync folder),
   and how it renders on desktop. Worth a spike doc, not code yet.
7. **`ReservedRegion` module (if needed).** Only if a custom bar or the graph
   canvas needs to sit outside the safe area. Our standard-bars-everywhere
   approach may never need it — prefer that.
7a. **Poses (2026-10-12).** ✅ Laptop pose (horizontal crease) handled for Chat,
   side previews and Calendar via an inferred crease (`src/lib/fold.ts`); book pose
   keeps SwiftUI's hinge-centred columns; the simulator has no distinct tent pose
   (closed = outer display, no crease). The inferred crease assumes the window fills
   the display — `ReservedRegion` (7) replaces it for Split View.
8. **No-ops to explicitly ignore**: CameraCaptureAccessory / Virtual Front
   Camera (no camera features), tent/StandBy postures (no media playback),
   Touch ID changes nothing for us (keychain access is unchanged; no Face ID
   code exists to break).

## 6. Open questions

- ✅ ANSWERED for §5.0: Expo's `NavigationSplitView` collapses via
  `preferredCompactColumn` (+ `onPreferredCompactColumnChange`); no local
  module or state-lifting fallback needed. Narrow router routes still exist
  for Android and deep links, but on iOS the selection store is the single
  source of truth — no bidirectional sync required.
- Does EAS offer an Xcode 27.1 image yet, and does `expo prebuild` with the
  iOS 27.1 SDK break any of our other native deps?
- Compact behaviour is size-class-driven now (no width threshold): which is
  the narrowest useful compact width for the notes list before it feels
  cramped — and does anything still key off 700 that shouldn't?
- For (6): attachment sync cost — a sketch PNG per note vs. the current
  text-only oplog.
