import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import { Stack } from "expo-router";
import { navigationBarHidden } from "@modules/swiftui-modifiers";
import { onSidebarItem, setSidebarGroup } from "@modules/tab-sidebar";
import { Host } from "@expo/ui";
import {
  ContentUnavailableView,
  NavigationSplitView,
  NavigationStack,
  type NavigationSplitViewVisibility,
} from "@expo/ui/swift-ui";
import {
  background,
  navigationSplitViewColumnWidth,
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
  const half = width / 2;
  // SwiftUI caps the sidebar column a little short of half the window (~20pt on
  // the Duo). That's fine: the detail screens' own side padding (~38pt) already
  // keeps their content clear of the fold, so no extra inset is added.

  // Items reported by bridged columns (iPad), drawn in the stack header.
  const [bridged, setBridged] = useState<Partial<Record<ChromeSlot, BridgedChrome | null>>>({});
  const bridge = useCallback((slot: ChromeSlot, chrome: BridgedChrome | null) => {
    setBridged((prev) => (prev[slot] === chrome ? prev : { ...prev, [slot]: chrome }));
  }, []);
  const hideBar = BRIDGE_HEADER ? [navigationBarHidden()] : [];

  // iPad: projects, each with its views, listed under the Projects tab in the
  // system tab sidebar — like Mail's accounts and mailboxes. (The Projects tab
  // is index 0.)
  const sidebarKey = projects.map((p) => `${p.id}:${p.name}`).join("|");
  useEffect(() => {
    if (!BRIDGE_HEADER || !projectId) return;
    setSidebarGroup(
      0,
      projects.map((p) => ({
        id: p.id,
        title: p.name,
        icon: "folder",
        children: VIEWS.map((v) => ({ id: v.id, title: v.title, icon: v.icon })),
      })),
      [projectId, view],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sidebarKey captures projects
  }, [sidebarKey, projectId, view]);
  useEffect(
    () =>
      onSidebarItem(([id, nextView]) => {
        const switching = id !== selection.projectId;
        setSelection({
          projectId: id,
          ...(nextView ? { view: nextView as SplitViewKind } : {}),
          ...(switching ? { noteId: null, cardId: null } : {}),
        });
      }),
    [],
  );

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
        onSelectView={selectView}
        onOpenNote={openNote}
        onOpenCard={openCard}
      />
    </ChromeColumn>
  );

  // Duo: opens the projects tree (the iPad has the system tab sidebar).
  const projectsButton = BRIDGE_HEADER
    ? []
    : [{ key: "projects", label: "Projects", icon: "folder" as const, onPress: () => setTreeOpen(true) }];

  // The open item (Notes), or the whole view (everything else).
  const detail =
      boardFull ? (
        <ChromeColumn key={`${projectId}:board`} leading={projectsButton} slot="primary">
          <View style={{ flex: 1, flexDirection: "row", overflow: "hidden" }}>
            <View style={{ flex: 1 }}>
              <ProjectScreen
                key={boardVersion}
                nested
                projectId={projectId}
                view="board"
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
        <ChromeColumn key={`${projectId}:overview`} leading={projectsButton} slot="secondary">
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
        <ChromeColumn key={`${projectId}:calendar`} leading={projectsButton} slot="secondary">
          <ProjectCalendarScreen nested projectId={projectId} onOpenCard={openCard} />
        </ChromeColumn>
      ) : view === "notes" && sel.noteId ? (
        <ChromeColumn
          key={sel.noteId}
          slot="secondary"
          leading={[{ key: "close", label: "Close note", icon: "xmark", onPress: () => setSelection({ noteId: null }) }]}
        >
          <NoteDetailScreen nested noteId={sel.noteId} onClose={() => setSelection({ noteId: null })} />
        </ChromeColumn>
      ) : (
        <ContentUnavailableView
          modifiers={[background(t.background), ...hideBar]}
          title="No Note Selected"
          systemImage="doc.text"
          description="Pick a note from the list."
        />
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
        {/* Views and projects live in the tab sidebar. This widens the open
            note to the whole window and back (not a second sidebar icon: the
            tab bar already has one). */}
        {fullWidth ? null : (
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
      {BRIDGE_HEADER ? <ChromeBridgeProvider value={bridge}>{body}</ChromeBridgeProvider> : body}
    </>
  );


  const hingeModifier = onHingeChange((_, next) => setHinge(rememberHingeStatus(next.hinge?.status ?? null)));
  // On a Duo the left column (and the tree panel) end exactly on the hinge.
  const leftWidth = hasHinge
    ? navigationSplitViewColumnWidth(half)
    : navigationSplitViewColumnWidth({ min: 300, ideal: 360, max: 440 });
  const tree = BRIDGE_HEADER ? null : (
    <ProjectsTreePanel
      open={treeOpen}
      onClose={() => setTreeOpen(false)}
      width={hasHinge ? half : Math.min(360, Math.round(width * 0.4))}
      title={workspaceName}
      projects={projects}
      views={VIEWS}
      projectId={projectId}
      view={view}
      progress={progress}
      onSelect={(id, next) => {
        setSelection({
          projectId: id,
          view: next as SplitViewKind,
          ...(id !== projectId ? { noteId: null, cardId: null } : {}),
        });
        setTreeOpen(false);
      }}
    />
  );

  // Each layout gets its own Host key: a hosted React Native view moved into a
  // different SwiftUI column otherwise renders blank.
  if (fullWidth) {
    return withHeader(
      <View style={{ flex: 1 }}>
        <Host key="single" style={{ flex: 1 }}>
          <NavigationStack modifiers={[tint(t.accent), hingeModifier]}>{detail}</NavigationStack>
        </Host>
        {tree}
      </View>,
    );
  }

  // ── Notes: list | note ────────────────────────────────────────────────────
  return withHeader(
    <View style={{ flex: 1 }}>
      <Host key="two-column" style={{ flex: 1 }}>
        <NavigationSplitView
          // The system sidebar button collapses the list for a full-width note.
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
          modifiers={[tint(t.accent), hingeModifier]}
        >
          <NavigationSplitView.Sidebar>{listColumn([leftWidth], projectsButton)}</NavigationSplitView.Sidebar>
          <NavigationSplitView.Detail>{detail}</NavigationSplitView.Detail>
        </NavigationSplitView>
      </Host>
      {tree}
    </View>,
  );
}
