# Mobile tab bar: five items at most

Status: proposal. Follows the People tab PR (#333), which made six tabs.

## Problem

iOS shows at most five tabs; a sixth folds the rest into **More**, and the
`role="search"` tab counts toward the five (seen on the simulator). With People
added we have Projects, Calendar, People, Chat, Graph and Search. For now Graph
folds into More on iPhone; the Duo side rail shows all six.

## Options

1. **Demote Graph (recommended).** Tabs: Projects, Calendar, People, Chat,
   Search. Graph becomes a screen pushed from Projects instead of a tab.
2. **Search as a floating button, not a tab.** Frees the slot, so Graph stays
   a tab. Rejected for now, for the reasons below.
3. **Fold something else.** People under Projects, or Calendar under Projects.
   Both are separate jobs people open on their own; folding either hides a
   daily destination to save one that is rarely opened.

### Why not the floating search button

- The `role="search"` tab gives the system search field that grows out of the
  tab bar (iOS 26), keyboard handling and the Search quick action for free.
  A floating button replaces that with our own overlay and a pushed or modal
  search screen.
- It would sit over every list, and collides with the things that already
  float or dock there: the Projects `+` capture, the calendar day panel, board
  drag, the keyboard, and on the Duo and iPad the side rail and split views.
  Each needs a position rule and an exception (Chat, as you noted).
- iOS convention for search outside a tab is a toolbar magnifier, which on the
  Duo becomes another rail item (the team page already stacks back, members and
  edit there).
- Keep it as the fallback if Graph turns out to matter more than the native
  search tab.

## Plan (option 1)

1. **Move the route.** `app/(tabs)/graph/` becomes `app/(tabs)/projects/graph`
   with a Stack.Screen in `projects/_layout.tsx` (regular title, like
   `project/calendar`). The native tab bar stays visible while it is open, and
   re-tapping Projects pops back, same as notes and cards.
2. **Remove the trigger** from `app/(tabs)/_layout.tsx`; the order is
   Projects, Calendar, People, Chat, Search, and the comment about folding goes.
3. **Entry points.** A "Knowledge graph" item in the Projects toolbar menu
   (iPhone, and the Duo rail overflow), and a link at the foot of the Search
   empty state. Add a quick action only if usage justifies it.
4. **Deep links and references.** Find anything that targets the old path
   (`/graph`, widgets, App Intents, onboarding guide copy that names the Graph
   tab) and repoint it.
5. **Layout checks.** Graph full screen on iPhone, the Duo closed rail and open
   pose, iPad sidebar (`sidebarAdaptable` lists tabs, so Graph leaves it).
6. **Tests and changelog.** No logic change; run mobile tsc, eslint, vitest.
   One line in the pending `mobile/changelogs/v0.1.22.md` (Graph moved).

Android uses Material bottom navigation, which already allows five, so it
follows the same order with no `role="search"` special case.

## Open questions

- How often is Graph opened? If it is a headline feature, prefer option 2.
- Projects toolbar menu or the Search empty state as the main door, or both?
- Should the Duo rail keep Graph one tap away (a rail button on Projects)?

## Related

- The sheet Done button hidden under the Duo status pill, and the full-width
  open pose, are tracked in `mobile-people.md` under "Findings from PR 1".
