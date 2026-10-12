import { useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { Platform, useWindowDimensions, View, Text } from "react-native";
import { Stack } from "expo-router";
import { FileText, ListTodo, CalendarDays, LayoutDashboard } from "lucide-react-native";
import { Host } from "@expo/ui";
import {
  ContentUnavailableView,
  NavigationSplitView,
  type NavigationSplitViewColumn,
  type NavigationSplitViewVisibility,
} from "@expo/ui/swift-ui";
import {
  navigationSplitViewStyle,
  onHingeChange,
  tint,
  type HingeStatus,
  type ViewModifier,
} from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";
import { type ProjectSummary } from "@/db/queries";
import { ProjectScreen, type ProjectTab } from "@/screens/ProjectScreen";
import { NoteDetailScreen } from "@/screens/NoteDetailScreen";
import { CardDetailScreen } from "@/screens/CardDetailScreen";
import { NoteComposer } from "@/components/NoteComposer";
import { TaskComposer } from "@/components/TaskComposer";
import { ProjectsTreeSidebar } from "@/components/ProjectsTreeSidebar";
import { useProjectsTree } from "@/components/projects-tree";
import { ProjectCalendarScreen } from "@/screens/ProjectCalendarScreen";
import {
  bridgedItems,
  ChromeBridgeProvider,
  ChromeColumn,
  routeItems,
  type BridgedChrome,
  type ChromeSlot,
} from "@/components/screen-chrome";
import { useTheme, type as typeScale } from "@/theme";
import { PressableScale } from "@/components/PressableScale";
import { lastHingeStatus, rememberHingeStatus } from "@/lib/hinge";

/**
 * Projects on wide windows (unfolded iPhone Duo, iPad): tree | view | item.
 *
 *   iPad — like Mail: the tree sidebar, the project view, the open item.
 *          Column buttons share the floating tab bar's row.
 *   Duo  — the same tree in the sidebar column (hidden by the system when
 *          there isn't room — the column bar then offers its toggle).
 *          Notes is list | note with the list ending on the hinge.
 */

type SplitViewKind = ProjectTab | "calendar";

interface Selection {
  projectId: string | null;
  view: SplitViewKind;
  noteId: string | null;
  cardId: string | null;
  /**
   * Inline composer open in the detail column (wide layouts only): a new note,
   * or a new task (optionally pre-set to a board column).
   */
  composing: false | "note" | { task: true; column?: string };
}

// Module-level so the selection survives the split view unmounting when the
// Duo folds to the phone layout and remounting when it unfolds.
let selection: Selection = { projectId: null, view: "notes", noteId: null, cardId: null, composing: false };
const listeners = new Set<() => void>();
function setSelection(next: Partial<Selection>) {
  selection = { ...selection, ...next };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function useSelection(): Selection {
  return useSyncExternalStore(subscribe, () => selection);
}

/** Reset the selection (e.g. after a workspace switch unmounts the data). */
export function resetProjectsSelection() {
  setSelection({ projectId: null, view: "notes", noteId: null, cardId: null, composing: false });
}

// SPIKE (2026-10-11, continuity): one adaptive container for the whole Projects
// hierarchy — a single NavigationSplitView always mounted, collapsing to one
// column when compact via preferredCompactColumn. No width-switched subtrees,
// no Host-key swaps: fold/unfold must morph, never remount.

// iPad's floating tab bar owns the top row, and SwiftUI column bars go below
// it — a whole band of wasted height. There the columns hide their bars and
// their buttons move into the native stack header, which shares the tab bar's
// row. (The Duo's tab bar is a side rail, so its columns keep their own bars.)
const BRIDGE_HEADER = Platform.OS === "ios" && Platform.isPad;

// Feature flag: the projects tree in the iPad's system tab sidebar
// (modules/tab-sidebar) — reserved for a future enhancement; the split-view
// sidebar column serves both devices today.
// Leaving focus mode (detailOnly) returns to list | item with the sidebar still
// hidden — "all" would pop the sidebar open over a note/task the user just closed.
const LEAVE_FOCUS: NavigationSplitViewVisibility = "doubleColumn";
const BOTH_SLOTS: readonly ChromeSlot[] = ["primary", "secondary"];
const LIST_SLOT: readonly ChromeSlot[] = ["primary"];
const NO_SLOTS: readonly ChromeSlot[] = [];

const VIEWS: { id: SplitViewKind; title: string; icon: SFSymbol }[] = [
  { id: "overview", title: "Overview", icon: "number" },
  { id: "notes", title: "Notes", icon: "doc.text" },
  { id: "board", title: "Board", icon: "rectangle.split.3x1" },
  { id: "calendar", title: "Calendar", icon: "calendar" },
];

export function ProjectsSplitView({
  projects,
  workspaceName,
  onWorkspaceSwitched,
}: {
  projects: ProjectSummary[];
  workspaceName: string;
  /** Called after the sidebar switches workspace, so the owner reloads. */
  onWorkspaceSwitched: () => void;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const sel = useSelection();
  const project = projects.find((p) => p.id === sel.projectId) ?? projects[0];
  const projectId = project?.id ?? null;
  // The selected project vanished (deleted or synced away on another device):
  // move the selection to the fallback so the collapsed column and the detail
  // column don't keep pointing into the old project. Skipped while the list
  // is still empty (first load).
  const stale = projects.length > 0 && sel.projectId != null && !projects.some((p) => p.id === sel.projectId);
  useEffect(() => {
    if (stale) setSelection({ projectId: projects[0].id, noteId: null, cardId: null, composing: false });
  }, [stale, projects]);
  const view = sel.view;
  // The Board is wide, so an open task slides in as a panel beside it (inside
  // the same column, so the board never remounts or moves).
  const boardFull = view === "board";

  // Bumped when a task changes in the detail column, so the board and the
  // sidebar progress re-read (they otherwise refresh only on focus / sync).
  const [boardVersion, setBoardVersion] = useState(0);

  // ── Duo posture ────────────────────────────────────────────────────────────
  // The hinge status feeds the shared cache (SidePreviewPane and others read
  // it); column widths are SwiftUI's job, so nothing here branches on it.
  const [, setHinge] = useState<HingeStatus | null>(lastHingeStatus);
  // Notes only: "detailOnly" is focus mode (the note gets the whole window).
  // Visibility starts at "doubleColumn" (sidebar hidden): on room-short
  // windows SwiftUI asks for it anyway, and starting at "all" opens the
  // sidebar as an overlay over fresh launches. The header (iPad) and native
  // toggles (Duo) open it on demand.
  const [visibility, setVisibility] = useState<NavigationSplitViewVisibility>("doubleColumn");
  // Focus needs an open note: never leave an empty detail as the only column.
  // Adjusted during render, so the list never flashes hidden.
  if (visibility === "detailOnly" && !sel.noteId) setVisibility(LEAVE_FOCUS);
  // SwiftUI caps the sidebar column a little short of half the window (~20pt on
  // the Duo). That's fine: the detail screens' own side padding (~38pt) already
  // keeps their content clear of the fold, so no extra inset is added.
  // SPIKE: compact proxy for the collapsed split view. A visibility/selection
  // hint only — the component tree never swaps, so nothing remounts.
  const compact = width < 700;
  // The collapsed column follows the selection depth: tree → project view →
  // open item, mirroring the phone drill-down (projects → project → note).
  const compactColumn: NavigationSplitViewColumn =
    sel.noteId || sel.composing || sel.cardId ? "detail" : sel.projectId ? "content" : "sidebar";
  const onCompactColumn = (col: NavigationSplitViewColumn) => {
    if (col === compactColumn) return;
    if (col === "content") setSelection({ noteId: null, cardId: null, composing: false });
    else if (col === "sidebar") setSelection({ projectId: null, noteId: null, cardId: null, composing: false });
    // "detail" carries no pop information — the selection already says what's open.
  };
  const hingeModifier = onHingeChange((_, next) => setHinge(rememberHingeStatus(next.hinge?.status ?? null)));
  // No width pins on any column: SwiftUI owns all widths. Explicit pins —
  // fixed numbers and stale-prone ideals alike — visibly missed the crease
  // across poses, while the unpinned board always reflowed correctly. Same treatment everywhere.

  // Items reported by bridged columns (iPad), drawn in the stack header.
  const [bridged, setBridged] = useState<Partial<Record<ChromeSlot, BridgedChrome | null>>>({});
  const bridge = useCallback((slot: ChromeSlot, chrome: BridgedChrome | null) => {
    setBridged((prev) => (prev[slot] === chrome ? prev : { ...prev, [slot]: chrome }));
  }, []);

  // The projects tree, one model for both renderers: the iPad's system tab
  // sidebar (the Projects tab is index 0) or the in-app panel.
  const onTreeSelect = useCallback((id: string, next?: string) => {
    setSelection({
      projectId: id,
      ...(next ? { view: next as SplitViewKind } : {}),
      ...(id !== selection.projectId || (next && next !== selection.view) ? { noteId: null, cardId: null } : {}),
      composing: false,
    });
  }, []);
  const tree = useProjectsTree({ projects, views: VIEWS, projectId, view, onSelect: onTreeSelect });

  // Switching panels (Overview → Notes, …) closes the open note/task: an item
  // from one panel must not stay selected inside another (a task open in Notes).
  const selectView = useCallback((next: SplitViewKind) => {
    setSelection({ view: next, ...(next !== selection.view ? { noteId: null, cardId: null } : {}), composing: false });
  }, []);
  // SPIKE: opening an item never switches the view out from under the user —
  // the item renders in Detail whatever the Content column shows.
  const openNote = useCallback((id: string) => setSelection({ noteId: id, cardId: null, composing: false }), []);
  // SPIKE: cards open in the Detail column (wide) or fullscreen (compact) —
  // never in the in-board slide-over anymore, so the right page is never empty.
  const openCard = useCallback((id: string) => setSelection({ cardId: id, noteId: null, composing: false }), []);
  // The list's + composes inline in the detail column (a native modal would
  // park on the wrong page on a Duo — there is no sheet-placement API).
  const openComposer = useCallback(() => setSelection({ view: "notes", composing: "note", noteId: null, cardId: null }), []);
  // New task: composed in the detail column too (the modal would park on the
  // left page of an unfolded Duo). Never switches the view (Board/Calendar).
  const composeTask = useCallback(
    (column?: string) => setSelection({ composing: { task: true, ...(column ? { column } : {}) }, noteId: null, cardId: null }),
    [],
  );

  if (!projectId) {
    return (
      <Host style={{ flex: 1 }}>
        <ContentUnavailableView title="No Projects" systemImage="folder" description="Sync a workspace to see its projects." />
      </Host>
    );
  }

  const listColumn = (extra: ViewModifier[], leading: Parameters<typeof ChromeColumn>[0]["leading"]) => (
    <ChromeColumn key={`${projectId}:${view}:${boardVersion}`} modifiers={extra} leading={leading} slot="primary">
      <ProjectScreen
        nested
        projectId={projectId}
        view={view as ProjectTab}
        selectedId={sel.noteId}
        onSelectView={selectView}
        onOpenNote={openNote}
        onOpenCard={openCard}
        onComposeNote={openComposer}
        onComposeTask={composeTask}
      />
    </ChromeColumn>
  );

  // Column widths are SwiftUI's job (see hingeModifier above) — no pins here.

  // Closing the note also leaves focus mode, so the list is never left hidden
  // behind an empty detail.
  const closeNote = () => {
    setSelection({ noteId: null, composing: false });
    setVisibility((v) => (v === "detailOnly" ? LEAVE_FOCUS : v));
  };

  // Where buttons go:
  //   iPad — the stack header: the list's / board's items left of the tab bar,
  //          the open item's or view's own items right of it.
  //   Duo  — the bar that docks into the side rail: every view's own column,
  //          and on Notes the note column, which also carries the list's
  //          items (the list keeps just its title).
  const slot = (s: ChromeSlot) => (BRIDGE_HEADER ? s : undefined);
  // Duo: the open note's bar also carries the list's items — while a note is
  // open, drop the list's own + (a full bar already). With no note open the +
  // stays (it's the only creation entry point there). iPad keeps it always:
  // its header shares the tab bar's row, so there's room.
  const listItems = BRIDGE_HEADER
    ? []
    : bridgedItems(bridged.primary).filter((i) => sel.noteId == null || i.key !== "add");

  // Detail always hosts the open item or the per-view action panel below, so
  // every column stays mounted across fold/unfold.

  // The open item (Notes), or the whole view (everything else).
  // SPIKE: the project view is always the Content column; the open note (or a
  // placeholder) is always the Detail column. Both stay mounted across
  // fold/unfold — only the split view's own collapse changes what is shown.
  const contentView =
      boardFull ? (
        // An open card lives in the Detail column now (not a slide-over here),
        // so the board always has the whole Content column.
        <ChromeColumn
          key={`${projectId}:board`}
          slot={slot("primary")}
          hideItems={!BRIDGE_HEADER && !!sel.cardId}
        >
          <ProjectScreen
            key={boardVersion}
            nested
            projectId={projectId}
            view="board"
            selectedId={sel.cardId}
            onSelectView={selectView}
            onOpenNote={openNote}
            onOpenCard={openCard}
            onComposeTask={composeTask}
          />
        </ChromeColumn>
      ) : view === "overview" ? (
        <ChromeColumn key={`${projectId}:overview`} slot={slot("primary")}>
          <ProjectScreen
            nested
            projectId={projectId}
            view="overview"
            onSelectView={selectView}
            onOpenNote={openNote}
            onOpenCard={openCard}
          />
        </ChromeColumn>
      ) : view === "calendar" ? (
        <ChromeColumn key={`${projectId}:calendar`} slot={slot("primary")}>
          <ProjectCalendarScreen nested projectId={projectId} onOpenCard={openCard} />
        </ChromeColumn>
      ) : (
        // No item open: Detail hosts the action panel below, so the list
        // keeps its hinge pin unconditionally.
        listColumn([], [])
      );

  // Closing the card also leaves focus mode, so the list is never left hidden
  // behind an empty detail.
  const closeCard = () => {
    setSelection({ cardId: null });
    setVisibility((v) => (v === "detailOnly" ? LEAVE_FOCUS : v));
  };

  // The column's ✕ — only when expanded. Collapsed (folded Duo, compact
  // iPad) the split view's own Back pops to the same place, and Apple's side
  // rail wants one dismiss at the top, not two.
  const dismiss = (label: string, onPress: () => void) =>
    compact ? [] : [{ key: "close", label, icon: "xmark" as const, onPress }];

  // The open note or task. Both stay mounted across fold/unfold — the split
  // view's own collapse is the only thing that hides or shows them.
  const detailView =
      sel.cardId ? (
        <ChromeColumn
          key={sel.cardId}
          slot={slot("secondary")}
          leading={dismiss("Close task", closeCard)}
        >
          <CardDetailScreen
            cardId={sel.cardId}
            onClose={closeCard}
            onChanged={() => setBoardVersion((n) => n + 1)}
          />
        </ChromeColumn>
      ) : sel.noteId ? (
        <ChromeColumn
          key={sel.noteId}
          slot={slot("secondary")}
          leading={dismiss("Close note", closeNote)}
          extra={listItems}
        >
          <NoteDetailScreen nested noteId={sel.noteId} onClose={closeNote} />
        </ChromeColumn>
      ) : sel.composing && sel.composing !== "note" ? (
        // Inline task composer — same reasoning as the note composer below.
        <ChromeColumn
          key="compose-task"
          slot={slot("secondary")}
          leading={dismiss("Discard task", () => setSelection({ composing: false }))}
        >
          <TaskComposer
            projectId={projectId}
            column={sel.composing.column}
            onSaved={(id) => {
              setSelection({ cardId: id, composing: false });
              setBoardVersion((n) => n + 1);
            }}
          />
        </ChromeColumn>
      ) : sel.composing ? (
        // Inline composer: a native modal would park on the wrong page on a
        // Duo (no sheet-placement API), so composing happens here, in the
        // note column. No bridged extras — the bar is just ✕ + Save.
        <ChromeColumn
          key="compose"
          slot={slot("secondary")}
          leading={dismiss("Discard note", () => setSelection({ composing: false }))}
        >
          <NoteComposer
            projectId={projectId}
            onSaved={(id) => setSelection({ noteId: id, composing: false })}
          />
        </ChromeColumn>
      ) : null;

  // Detail with nothing open: a per-view action panel, so the right page
  // earns its space instead of sitting blank.
  const newTask = () => composeTask();
  const emptyDetail =
    view === "board" ? (
      <ChromeColumn key="empty" slot={slot("secondary")}>
        <DetailActionPanel icon={ListTodo} title="No task selected" body="Pick a task from the board — or start a new one." actionLabel="New task" onAction={newTask} />
      </ChromeColumn>
    ) : view === "calendar" ? (
      <ChromeColumn key="empty" slot={slot("secondary")}>
        <DetailActionPanel icon={CalendarDays} title="No task selected" body="Pick a task from the calendar — or start a new one." actionLabel="New task" onAction={newTask} />
      </ChromeColumn>
    ) : view === "overview" ? (
      <ChromeColumn key="empty" slot={slot("secondary")}>
        <DetailActionPanel icon={LayoutDashboard} title="Nothing open" body="Open a note or task to read it beside the overview." actionLabel="View board" onAction={() => selectView("board")} />
      </ChromeColumn>
    ) : (
      <ChromeColumn key="empty" slot={slot("secondary")}>
        <DetailActionPanel icon={FileText} title="No note selected" body="Pick a note from the list — or start a new one." actionLabel="New note" onAction={openComposer} />
      </ChromeColumn>
    );

  const toggleSidebar = () => setVisibility((v) => (v === "detailOnly" ? "all" : "detailOnly"));
  // iPad tab header: the sidebar toggle. Column bars are bridged (hidden) on
  // iPad, so SwiftUI's own sidebar toggle is invisible with them — this is
  // the only way to open the tree when the system hides it for room. (On Duo
  // the columns keep their bars, so the native toggle shows in the list bar.)
  const toggleTree = () => setVisibility((v) => (v === "all" ? "doubleColumn" : "all"));
  // Phone (Duo): the columns draw their own bars, so the stack header hides.
  // iPad: an untitled header in the tab bar's row carries every button — the
  // focus toggle and the list's items, then (right of the tab bar) the open
  // item's.
  const header = BRIDGE_HEADER ? (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: "",
          headerLargeTitle: false,
          headerStyle: { backgroundColor: t.background },
          contentStyle: { backgroundColor: t.background },
        }}
      />
      <Stack.Toolbar placement="left">
        {/* Tree toggle first: the only way to open the sidebar on iPad. */}
        <Stack.Toolbar.Button
          icon="sidebar.left"
          accessibilityLabel={visibility === "all" ? "Hide sidebar" : "Show sidebar"}
          onPress={toggleTree}
        />
        {/* The focus toggle widens the open note to the whole window and back. */}
        {view !== "notes" || !sel.noteId ? null : (
          <Stack.Toolbar.Button
            icon={visibility === "detailOnly" ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
            accessibilityLabel={visibility === "detailOnly" ? "Show list" : "Focus"}
            onPress={toggleSidebar}
          />
        )}
        {routeItems(bridgedItems(bridged.primary))}
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">{routeItems(bridgedItems(bridged.secondary))}</Stack.Toolbar>
    </>
  ) : (
    <Stack.Screen options={{ headerShown: false, contentStyle: { backgroundColor: t.background } }} />
  );
  const withHeader = (body: ReactElement) => (
    <>
      {header}
      {/* Duo: the notes list is bridged into the note column's bar only while
          both are on screen (unfolded, a note open). Folded, or with nothing
          open, the list keeps its own + — otherwise New note vanishes with
          the column it was moved to. */}
      <ChromeBridgeProvider
        value={bridge}
        keepBars={!BRIDGE_HEADER}
        slots={BRIDGE_HEADER ? BOTH_SLOTS : !compact && sel.noteId ? LIST_SLOT : NO_SLOTS}
      >
        {body}
      </ChromeBridgeProvider>
    </>
  );


  // ── Unified hierarchy: tree | view | item ─────────────────────────────────
  // One stable Host, one NavigationSplitView, always mounted. The same
  // container collapses (compact) ↔ expands (regular): the open note, its
  // draft, and the list never unmount across fold/unfold.
  //
  // NOTE (2026-10-11): a native split ArrangementView was spiked here as an
  // alternative to NavigationSplitView and killed: simulator frame logs showed
  // byte-identical columns ([0,456] / [496,867] half-folded), and the
  // arrangement needed per-side NavigationStacks for the column bars —
  // navigation *inside* the arrangement, contrary to Apple ("keep navigation
  // outside of arrangement views"). Here navigation stays outside and the
  // columns are navigation-free ChromeColumns, which is exactly Apple's
  // containment. See docs/plans/iphone-duo.md.
  return withHeader(
    <>
      <Host style={{ flex: 1 }}>
        <NavigationSplitView
          // True echo (except the spurious first-layout detailOnly with
          // nothing open, which is swallowed): controlled visibility only
          // settles when SwiftUI's reports are acknowledged.
          columnVisibility={
            compact ? "automatic" : visibility === "detailOnly" && sel.noteId ? "detailOnly" : visibility
          }
          onColumnVisibilityChange={(v) => {
            // Swallow the spurious first-layout detailOnly with nothing open;
            // echo everything else back (controlled visibility only settles
            // when SwiftUI's reports are acknowledged).
            if (v === "detailOnly" && !selection.noteId) return;
            setVisibility(v);
          }}
          // Collapsed (compact) the split view is a single column following
          // the selection depth; expanded it shows tree | view | item.
          // Controlled: the handler above feeds the user's Back back into
          // the selection, which recomputes this value.
          preferredCompactColumn={compactColumn}
          onPreferredCompactColumnChange={onCompactColumn}
          // Automatic: the style owns how many columns fit. ("balanced" was
          // correct for the old two-column notes split — side by side, never
          // overlaid — but in a three-column split it pins content+detail and
          // hides the sidebar everywhere, iPad included.)
          modifiers={[tint(t.accent), hingeModifier, navigationSplitViewStyle("automatic")]}
        >
          <NavigationSplitView.Sidebar>
            <ProjectsTreeSidebar title={workspaceName} tree={tree} onWorkspaceSwitched={onWorkspaceSwitched} />
          </NavigationSplitView.Sidebar>
          <NavigationSplitView.Content>{contentView}</NavigationSplitView.Content>
          {/* Detail stays mounted ALWAYS — SwiftUI reserves the slot even for
              a null child, so a conditional only trades the action panel for
              a blank page. Period. */}
          <NavigationSplitView.Detail>{detailView ?? emptyDetail}</NavigationSplitView.Detail>
        </NavigationSplitView>
      </Host>
    </>,
  );
}

/**
 * Detail column with nothing open: a per-view action panel so the right page
 * earns its space (SwiftUI reserves the slot even when empty — a conditional
 * only trades this panel for a blank page).
 */
function DetailActionPanel({
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction,
}: {
  icon: typeof FileText;
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10, backgroundColor: t.background }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.surface2,
          borderWidth: 1,
          borderColor: t.border,
        }}
      >
        <Icon size={26} color={t.textTertiary} />
      </View>
      <Text style={[typeScale.subtitle, { color: t.textPrimary, fontWeight: "700", textAlign: "center" }]}>{title}</Text>
      <Text style={[typeScale.caption, { color: t.textSecondary, textAlign: "center", lineHeight: 18 }]}>{body}</Text>
      <PressableScale
        onPress={onAction}
        style={{ marginTop: 6, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 20, backgroundColor: t.accent }}
      >
        <Text style={[typeScale.control, { color: "#fff", fontWeight: "700" }]}>{actionLabel}</Text>
      </PressableScale>
    </View>
  );
}
