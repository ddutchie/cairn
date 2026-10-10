import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import { Stack } from "expo-router";
import { onSidebarItem, setSidebarGroup, sidebarSupported } from "@modules/tab-sidebar";
import { Host } from "@expo/ui";
import {
  ContentUnavailableView,
  NavigationSplitView,
  NavigationStack,
  type NavigationSplitViewVisibility,
} from "@expo/ui/swift-ui";
import {
  navigationSplitViewColumnWidth,
  navigationSplitViewStyle,
  onHingeChange,
  tint,
  type HingeStatus,
  type ViewModifier,
} from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";
import { listCards, listColumns, type ProjectSummary } from "@/db/queries";
import { ProjectScreen, type ProjectTab } from "@/screens/ProjectScreen";
import { NoteDetailScreen } from "@/screens/NoteDetailScreen";
import { ChatPreviewPane } from "@/components/chat/ChatPreview";
import { ProjectsTreePanel } from "@/components/ProjectsTreePanel";
import { EmptyState } from "@/components/EmptyState";
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
import { isDoneColumn } from "@/gamification/rewards";
import { useTheme } from "@/theme";
import { lastHingeStatus, rememberHingeStatus } from "@/lib/hinge";

/**
 * Projects on wide windows (unfolded iPhone Duo, iPad): list | item.
 *
 *   iPad — like Mail: projects and their views are listed in the system tab
 *          sidebar; Notes shows list | note, every other view the full width.
 *          Column buttons share the floating tab bar's row.
 *   Duo  — the same tree in a panel that slides over the left page (the
 *          folder button). Notes is list | note with the left column ending on
 *          the hinge: list on one page, note on the other.
 */

type SplitViewKind = ProjectTab | "calendar";

interface Selection {
  projectId: string | null;
  view: SplitViewKind;
  noteId: string | null;
  cardId: string | null;
}

// Module-level so the selection survives the split view unmounting when the
// Duo folds to the phone layout and remounting when it unfolds.
let selection: Selection = { projectId: null, view: "notes", noteId: null, cardId: null };
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


// iPad's floating tab bar owns the top row, and SwiftUI column bars go below
// it — a whole band of wasted height. There the columns hide their bars and
// their buttons move into the native stack header, which shares the tab bar's
// row. (The Duo's tab bar is a side rail, so its columns keep their own bars.)
const BRIDGE_HEADER = Platform.OS === "ios" && Platform.isPad;

// Feature flag: the projects tree in the iPad's system tab sidebar
// (modules/tab-sidebar). Off — or if the module can't install — the iPad uses
// the same slide-over panel as the Duo.
const SYSTEM_SIDEBAR = sidebarSupported;

const VIEWS: { id: SplitViewKind; title: string; icon: SFSymbol }[] = [
  { id: "overview", title: "Overview", icon: "number" },
  { id: "notes", title: "Notes", icon: "doc.text" },
  { id: "board", title: "Board", icon: "rectangle.split.3x1" },
  { id: "calendar", title: "Calendar", icon: "calendar" },
];

export function ProjectsSplitView({
  projects,
  workspaceName,
}: {
  projects: ProjectSummary[];
  workspaceName: string;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const sel = useSelection();
  const project = projects.find((p) => p.id === sel.projectId) ?? projects[0];
  const projectId = project?.id ?? null;
  const view = sel.view;
  // The Board is wide, so it always takes the whole window; an open task slides
  // in as a panel beside it (inside the same column, so the board never
  // remounts or moves).
  const boardFull = view === "board";
  const listView = view === "notes";
  // Views without a list take the whole window; projects and views are picked
  // from a tree (iPad: the system tab sidebar; Duo: a slide-over panel), so no
  // column is needed for them.
  const fullWidth = !listView;
  const [treeOpen, setTreeOpen] = useState(false);

  // Bumped when a task changes in the detail column, so the board and the
  // sidebar progress re-read (they otherwise refresh only on focus / sync).
  const [boardVersion, setBoardVersion] = useState(0);

  const progress = useMemo(() => {
    if (!projectId) return null;
    const done = new Set(listColumns(projectId).filter(isDoneColumn).map((c) => c.id));
    const cards = listCards(projectId);
    const closed = cards.filter((c) => done.has(c.column_id)).length;
    return { closed, total: cards.length, open: cards.length - closed };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boardVersion forces a re-read
  }, [projectId, boardVersion]);

  // ── Duo posture ────────────────────────────────────────────────────────────
  const [hinge, setHinge] = useState<HingeStatus | null>(lastHingeStatus);
  const hasHinge = hinge != null && hinge !== "closed";
  // Notes only: "detailOnly" is focus mode (the note gets the whole window).
  const [visibility, setVisibility] = useState<NavigationSplitViewVisibility>("all");
  // Focus needs an open note: never leave an empty detail as the only column.
  // Adjusted during render, so the list never flashes hidden.
  if (visibility === "detailOnly" && !sel.noteId) setVisibility("all");
  const half = width / 2;
  // SwiftUI caps the sidebar column a little short of half the window (~20pt on
  // the Duo). That's fine: the detail screens' own side padding (~38pt) already
  // keeps their content clear of the fold, so no extra inset is added.

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
      ...(id !== selection.projectId ? { noteId: null, cardId: null } : {}),
    });
    setTreeOpen(false);
  }, []);
  const tree = useProjectsTree({ projects, views: VIEWS, projectId, view, onSelect: onTreeSelect });
  const [systemSidebar, setSystemSidebar] = useState(SYSTEM_SIDEBAR);
  useEffect(() => {
    if (!SYSTEM_SIDEBAR || !projectId) return;
    let live = true;
    void setSidebarGroup(0, tree.nodes, tree.selectedPath).then((ok) => {
      if (live) setSystemSidebar(ok);
    });
    return () => {
      live = false;
    };
  }, [tree.nodes, tree.selectedPath, projectId]);
  useEffect(() => (SYSTEM_SIDEBAR ? onSidebarItem(tree.select) : undefined), [tree.select]);

  const selectView = useCallback((next: SplitViewKind) => {
    setSelection({ view: next });
  }, []);
  const openNote = useCallback((id: string) => setSelection({ view: "notes", noteId: id }), []);
  const openCard = useCallback((id: string) => setSelection({ view: "board", cardId: id }), []);

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
      />
    </ChromeColumn>
  );

  // The note column's own minimum. SwiftUI's default is wide enough that half
  // the window for the list plus it doesn't fit an unfolded Duo beside its tab
  // rail, and the split then falls back to overlaying the list on the note.
  const detailWidth = navigationSplitViewColumnWidth({ min: 280, ideal: half });

  // Closing the note also leaves focus mode, so the list is never left hidden
  // behind an empty detail.
  const closeNote = () => {
    setSelection({ noteId: null });
    setVisibility("all");
  };

  // Opens the in-app tree (not needed while the system sidebar has it).
  const projectsButton = systemSidebar
    ? []
    : [{ key: "projects", label: "Projects", icon: "folder" as const, onPress: () => setTreeOpen(true) }];
  // Where buttons go:
  //   iPad — the stack header: the folder first on the left (drawn by the
  //          header itself), the list's / board's items after it, the open
  //          item's or view's own items right of the tab bar.
  //   Duo  — the bar that docks into the side rail: every view's own column,
  //          and on Notes the note column, which also carries the list's
  //          items (the list keeps just its title).
  const columnFolder = BRIDGE_HEADER ? [] : projectsButton;
  const slot = (s: ChromeSlot) => (BRIDGE_HEADER ? s : undefined);
  const listItems = BRIDGE_HEADER ? [] : bridgedItems(bridged.primary);

  // The open item (Notes), or the whole view (everything else).
  const detail =
      boardFull ? (
        // While a task is open, its panel brings ✕ / ⋯ / Save; the board's own
        // + would only crowd the bar (the Duo's rail stacks both).
        <ChromeColumn key={`${projectId}:board`} leading={columnFolder} slot={slot("primary")} hideItems={!!sel.cardId}>
          <View style={{ flex: 1, flexDirection: "row", overflow: "hidden" }}>
            <View style={{ flex: 1 }}>
              <ProjectScreen
                key={boardVersion}
                nested
                projectId={projectId}
                view="board"
                selectedId={sel.cardId}
                onSelectView={selectView}
                onOpenNote={openNote}
                onOpenCard={openCard}
              />
            </View>
            <ChatPreviewPane
              preview={sel.cardId ? { kind: "card", id: sel.cardId } : null}
              onClose={() => setSelection({ cardId: null })}
              onChanged={() => setBoardVersion((n) => n + 1)}
            />
          </View>
        </ChromeColumn>
      ) : view === "overview" ? (
        <ChromeColumn key={`${projectId}:overview`} leading={columnFolder} slot={slot("secondary")}>
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
        <ChromeColumn key={`${projectId}:calendar`} leading={columnFolder} slot={slot("secondary")}>
          <ProjectCalendarScreen nested projectId={projectId} onOpenCard={openCard} />
        </ChromeColumn>
      ) : view === "notes" && sel.noteId ? (
        <ChromeColumn
          key={sel.noteId}
          slot={slot("secondary")}
          modifiers={[detailWidth]}
          leading={[...columnFolder, { key: "close", label: "Close note", icon: "xmark", onPress: closeNote }]}
          extra={listItems}
        >
          <NoteDetailScreen nested noteId={sel.noteId} onClose={closeNote} />
        </ChromeColumn>
      ) : (
        // A column (not a bare SwiftUI view) so it has a bar for the Duo's
        // folder and list buttons.
        <ChromeColumn key="no-note" slot={slot("secondary")} modifiers={[detailWidth]} leading={columnFolder} extra={listItems}>
          <EmptyState title="No note selected" subtitle="Pick a note from the list." />
        </ChromeColumn>
      );

  const toggleSidebar = () => setVisibility((v) => (v === "detailOnly" ? "all" : "detailOnly"));
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
        {projectsButton.map((b) => (
          <Stack.Toolbar.Button key={b.key} icon={b.icon} accessibilityLabel={b.label} onPress={b.onPress} />
        ))}
        {/* Views and projects live in the tab sidebar. This widens the open
            note to the whole window and back (not a second sidebar icon: the
            tab bar already has one). */}
        {fullWidth || !sel.noteId ? null : (
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
      {/* Duo: only the notes list is bridged, into the note column's bar. */}
      <ChromeBridgeProvider value={bridge} keepBars={!BRIDGE_HEADER}>
        {body}
      </ChromeBridgeProvider>
    </>
  );


  const hingeModifier = onHingeChange((_, next) => setHinge(rememberHingeStatus(next.hinge?.status ?? null)));
  // On a Duo the left column (and the tree panel) end exactly on the hinge.
  const leftWidth = hasHinge
    ? navigationSplitViewColumnWidth(half)
    : navigationSplitViewColumnWidth({ min: 300, ideal: 360, max: 440 });
  const treePanel = systemSidebar ? null : (
    <ProjectsTreePanel
      open={treeOpen}
      onClose={() => setTreeOpen(false)}
      width={hasHinge ? half : Math.min(360, Math.round(width * 0.4))}
      title={workspaceName}
      tree={tree}
      progress={progress}
    />
  );

  // Each layout gets its own Host key: a hosted React Native view moved into a
  // different SwiftUI column otherwise renders blank.
  if (fullWidth) {
    return withHeader(
      <>
        <Host key="single" style={{ flex: 1 }}>
          <NavigationStack modifiers={[tint(t.accent), hingeModifier]}>{detail}</NavigationStack>
        </Host>
        {treePanel}
      </>,
    );
  }

  // ── Notes: list | note ────────────────────────────────────────────────────
  // The tree panel is absolutely positioned over the screen, so it's a sibling:
  // wrapping the Host in another view makes SwiftUI see a zero-width window on
  // first layout and collapse the list column for good.
  return withHeader(
    <>
      <Host key="two-column" style={{ flex: 1 }}>
        <NavigationSplitView
          // The system sidebar button collapses the list for a full-width note.
          columnVisibility={visibility}
          onColumnVisibilityChange={(v) => {
            // Focus needs a note. SwiftUI also collapses the list by itself
            // during the first layout pass; answer with a different "list
            // shown" value so the change is actually sent back to it.
            if (v === "detailOnly" && !selection.noteId) {
              setVisibility((prev) => (prev === "all" ? "doubleColumn" : "all"));
              return;
            }
            setVisibility(v);
          }}
          // Balanced: the list sits beside the note in every visibility, never
          // over it (the hinge layout depends on that).
          modifiers={[tint(t.accent), hingeModifier, navigationSplitViewStyle("balanced")]}
        >
          <NavigationSplitView.Sidebar>{listColumn([leftWidth], [])}</NavigationSplitView.Sidebar>
          <NavigationSplitView.Detail>{detail}</NavigationSplitView.Detail>
        </NavigationSplitView>
      </Host>
      {treePanel}
    </>,
  );
}
