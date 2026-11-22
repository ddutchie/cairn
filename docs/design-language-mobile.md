# Cairn design language, mobile

How the phone app (`mobile/`) is composed so it reads as the same product as the desktop. Read [`design-language.md`](design-language.md) first: the ideas (one memorable thing per view, say a number once, structure is information, open lists and raised instruments) are the same here. This document translates them to React Native and iOS, and records where the phone differs on purpose.

The reference screen is the project **Overview** (`mobile/src/components/overview/OverviewTab.tsx`), which follows the desktop Overview after its design pass. If this document and that screen disagree, fix whichever is wrong.

## What carries over unchanged

- **One memorable thing per view.** The project name and progress on Overview. Everything else stays quiet.
- **Say a number once.** If the progress card says "1 of 4" and the ring says 25%, no tile repeats either. The Overview strip shows needs attention, open tasks, notes and bottleneck, and no two of those restate each other or the hero.
- **Structure is information.** A rule, border or dot means something. No coloured top stripes on tiles, no coloured left edge on cards, no icon chip beside a section title.
- **Open lists, raised instruments.** Lists of items sit on the page under a heading. Instruments (progress ring, flow bars, radar) get a raised surface.
- **Colour carries status.** `danger`, `warning`, `success` and `info` go on text, a small dot or an icon, next to a word that says the same. A card may take a faint tint (about 7%), never a saturated fill. Colour is never the only signal.
- **Sentence case, plain copy.** "Needs attention", not "NEEDS ATTENTION". Buttons name the action. Prefer a comma or full stop to `·` in a sentence; `·` is fine between short metadata.
- **No developer notes in the UI.**

## Where the phone differs

| Topic | Desktop | Phone |
|---|---|---|
| Colours | CSS variables | The same tokens as `Theme` in `mobile/src/theme.ts` via `useTheme()`. Never a hex in a component. |
| Alpha | `color-mix(...)` | `withAlpha(token, 0.14)` from `@/theme`. |
| Display face | New York serif for headlines and numerals | Not yet: the phone uses the system face. Headlines use weight 500 or 600 from the type scale, never 700 for a section heading. Revisit if a display font ships. |
| Mono | Code, paths, kbd only | Same. Never `fontFamily: "Menlo"` for counts or dates: use `fontVariant: ["tabular-nums"]`. |
| Elevation | `shadow-elev-1/2/3` | `elevation.sm/md/lg/xl` from `@/theme`. Resting card: `sm`. Floating: `md`. A shadow needs a solid background colour on the same view (see Skia and RN warnings in the Metro log). |
| Hover | Surface steps up | There is none. Pressed state is `PressableScale` (a small scale and haptic), not a colour step. |
| Tilt | Instruments tilt toward the pointer | Never. |
| Width | Content caps at 1240px, two columns by container query | Two columns when the window is at least `WIDE_MIN_WIDTH` (700pt) wide, one otherwise. See "Window sizes". |

## Tokens

Use `useTheme()` (`mobile/src/theme.ts`), which mirrors `src/app/globals.css`:

| Role | Token | Notes |
|---|---|---|
| Page | `background` | |
| Item surface | `surface2` | Cards inside a section. |
| Raised surface | `surface` | A page-level card or instrument. |
| Hairlines | `borderSubtle` | Item rules. `border` only for controls and instruments. |
| Text | `textPrimary` / `textSecondary` / `textTertiary` | Tertiary is for meta, never for anything that must be read. |
| Accent | `accent`, `accentFg`, `accentDim` | One green by default; the user can change the accent. |
| Status | `danger`, `warning`, `success`, `info` | As above. |

Rules: no raw colour names or hex. Alpha through `withAlpha`. The theme follows the system scheme, so check light and dark.

## Type

Use the scale in `type` (`@/theme`, exported as `typeScale` in most files). Never an ad-hoc `fontSize` on a `Text` that has a token, and never a pixel size where a token exists.

| Use | Token |
|---|---|
| Screen and note titles | `display` (24/700), use sparingly |
| Section headings in a screen | `heading` (20) or `title` (17) |
| List item title | `title` or `control` |
| Body | `body` (15/400) |
| Labels, chips, segment text | `label` (13/600) |
| Meta, timestamps, counts | `caption` (13/400) or `micro` (11/500) |
| Chevrons and glyph text | `title` at weight 400 |

Do not use `overline` (uppercase, tracked) in new work. It remains in older screens and is being retired; use `label` or `caption` in sentence case instead. When you need a font size outside a `Text` (a native segmented control, a toolbar), read it from the token (`typeScale.control.fontSize`), not a literal.

Numbers that line up (counts, times, relative dates) use `fontVariant: ["tabular-nums"]` on the normal face.

## Layout

- **Left-aligned.** Centre only empty states.
- **Rhythm.** 12pt page padding, 14pt between sections, 12pt padding inside a card, 6 to 8pt between items. Hairline rules between rows rather than a box per row.
- **Priority order.** What the person must decide first, reference material (activity, runs) last.
- **Corners.** 12 to 14pt for cards and instruments, 10pt for chips and rows inside them, full round for pills.
- **Touch targets.** At least 44pt tall for anything tappable, using `hitSlop` where the glyph is smaller.

## Patterns

### Screen chrome

Every tab and pushed screen uses the small inline title (`TabStack`, `largeTitle` defaults to false). Buttons are described once through `ScreenChrome` (`@/components/screen-chrome`) so the back label, haptics and Duo side-rail behaviour apply everywhere. Do not hand-roll a header or a toolbar.

- Settings has one home, the **Workspace** tab (as on desktop). Other screens link to it, they do not repeat it.
- The pinned tool is a floating accessory on narrow windows and a toolbar button in the side rail on wide ones. Screens end above the accessory with `useAccessoryInset()`.

### Section heading

Title in `control` or `title`, an optional quiet note beside it, an optional action at the trailing edge, and no icon chip. Sentence case.

### Item card

A rounded block: `surface2` (or a faint status tint), a `borderSubtle` border, `elevation.sm`. A meta line on top (kind, status in colour, where it lives), the title, then a quiet detail line. Tapping scales it through `PressableScale`. One item per view may get a larger title and an accent-tinted surface (the focus item).

### Instrument

Progress, task flow, priority and the radar sit on `surface` with a `border` and `elevation.md`. The progress card: the ring holds the percentage, the numeral holds the count ("1 of 4"), a thin bar and the dates sit beneath, "done, N still open" under the numeral. A soft accent wash is welcome here and nowhere else.

### At a glance strip

One raised strip of tiles divided by hairlines. Each tile: short label, numeral, one line of detail. No status stripes. No two tiles, and no tile and the hero, show the same number.

### Segmented switchers

One `SegmentedControl` above the content, outside the scroll view, so switching never moves it (People, the project view switcher). Give it a fixed height only: a `flex: 1` basis collapses the native view.

### Empty states

`EmptyState`: say what to do next, not how the system feels.

## Window sizes

Branch on width, never on the device. The thresholds in `mobile/src/lib/layout.ts`:

- **Narrow** (under 700pt): one column, the pinned accessory floats above the tab bar. A closed Duo is 466pt wide.
- **Wide** (700pt and up): split view, two columns, the pinned tool and Capture dock into the side rail via the detail column's toolbar. An open or half-open Duo is about 951pt wide; iPads are wide.
- The Duo puts system chrome along a side edge (status bar, tab rail), so content respects horizontal safe-area insets (`useTabContentStyle`).
- Layout that reserves space for system chrome (the accessory, the keyboard) must follow the window, not assume a bottom bar.

## Colour, motion and haptics

- Motion answers an action (expanding, marking done, a switch). Nothing animates on load except one deliberate moment per view. Use `RollingText` for a changing numeral. Respect reduced motion.
- Haptics come from `@/haptics`: `selection` for a choice, `toolbarPress` for toolbar buttons. Do not add them to scrolling or passive updates.

## Accessibility

- Every tappable has an `accessibilityLabel`, and `accessibilityRole="button"` unless the component already sets one (`PressableScale` does not).
- A canvas (Skia map, graph) is not accessible by itself: offer the same choices as native buttons or a list.
- Adjustable controls (a slider) handle `accessibilityActions` for increment and decrement.
- Dynamic Type: use the type scale, test at a large size, and let rows grow rather than truncate important text.
- Test light and dark, and the narrow and wide windows.

## Things we removed on purpose

Do not bring these back without a reason specific to the view:

- All-caps, letter-spaced labels (`overline`) in new screens.
- Monospace for counts, dates or "ago" times.
- Coloured top stripes on stat tiles, and coloured left or priority stripes on cards.
- A numeral, a ring and a percent all showing the same value, or "done" said twice.
- Icon chips beside section titles.
- A bordered box around a list of already-separated rows (the Activity group).
- A floating accessory band on a wide window.

## Where the code lives

| Thing | File |
|---|---|
| Tokens, type scale, elevation, `withAlpha` | `mobile/src/theme.ts` |
| Window thresholds, side-rail helpers | `mobile/src/lib/layout.ts` |
| Screen title and toolbar | `mobile/src/components/screen-chrome.tsx`, `TabStack.tsx` |
| Pinned tool and accessory | `mobile/src/lib/workspace-tools.ts`, `PinnedAccessory.tsx` |
| Pressable feedback | `mobile/src/components/PressableScale.tsx` |
| Overview and its panels | `mobile/src/components/overview/` |
| People (list, Teams, Map, Rhythm, Zones) | `mobile/src/screens/People*.tsx`, `TeamsList.tsx`, `RhythmList.tsx`, `ZonesList.tsx` |
| Feature gaps against desktop | `docs/plans/mobile-desktop-parity.md` |

## Checking your work

1. Run the app on the iPhone Duo simulator in the closed (narrow) and open (wide) poses, and on a regular iPhone. Light and dark.
2. Ask: what is the one memorable thing? Is any number said twice? Is any box only wrapping other boxes? Is colour doing anything other than status or the primary action?
3. From `mobile/`: `npx tsc --noEmit` and `npx eslint . --max-warnings 0`.
4. Turn on VoiceOver and move through the screen: every control has a name and a role.

## Status

| Screen | State |
|---|---|
| Project Overview | Aligned: sentence case, tabular numerals, one progress count, no stripes, icon chips or nested boxes. |
| People (list, Teams, Map, Rhythm, Zones) | Mostly aligned; uses the type scale and item rows. Check against this document when next touched. |
| Workspace, Settings | Aligned for headers and grouping. |
| Board, Calendar, Notes, Chat, Search | Working surfaces: share tokens and the type scale, but not reviewed against this document. Several still use `overline` labels. |
| Usage, Knowledge graph | Not reviewed. |

When you align a screen, update this table.
