import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useWindowDimensions, View } from "react-native";
import { Host } from "@expo/ui";
import {
  Button,
  ContentUnavailableView,
  Label,
  List,
  Menu,
  NavigationSplitView,
  type NavigationSplitViewVisibility,
  ProgressView,
  Section,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  background,
  badge,
  contentShape,
  font,
  foregroundStyle,
  frame,
  listStyle,
  navigationSplitViewColumnWidth,
  navigationTitle,
  onHingeChange,
  onTapGesture,
  padding,
  shapes,
  tint,
  type HingeStatus,
  type ViewModifier,
} from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";
import { listCards, listColumns, type ProjectSummary } from "@/db/queries";
import { ProjectScreen, type ProjectTab } from "@/screens/ProjectScreen";
import { NoteDetailScreen } from "@/screens/NoteDetailScreen";
import Animated from "react-native-reanimated";
import { ChatPreviewPane, PREVIEW_LAYOUT } from "@/components/chat/ChatPreview";
import { ProjectCalendarScreen } from "@/screens/ProjectCalendarScreen";
import { ChromeColumn } from "@/components/screen-chrome";
import { isDoneColumn } from "@/gamification/rewards";
import { useTheme } from "@/theme";
import { lastHingeStatus, rememberHingeStatus } from "@/lib/hinge";

/**
 * Projects on wide windows (unfolded iPhone Duo, iPad), laid out like desktop:
 *
 *   sidebar  — project switcher + progress, and the project's views
 *   content  — the view's list (notes tree, board)
 *   detail   — the open note / task
 *
 * on wide iPads. Narrower windows (an unfolded Duo, a portrait iPad) show
 * list | item, with the sidebar's contents in the list's title menu. Overview
 * and Calendar have no list → item shape, so the sidebar becomes the left
 * column instead. On a Duo the
 * left column always ends on the hinge: list on one page, item on the other.
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

const ALL_COLUMNS_MIN_WIDTH = 1100;

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
  // Three native columns need room (wide iPads). Narrower — an unfolded Duo
  // is ~950pt — shows two: list | item, with the project + views in the list's
  // title menu instead of a third column squeezed across the fold.
  const roomy = width >= ALL_COLUMNS_MIN_WIDTH;
  const [visibility, setVisibility] = useState<NavigationSplitViewVisibility>(boardFull ? "detailOnly" : "all");
  // Full-width board hides the other columns (the system sidebar button still
  // reveals them); leaving it restores them. Adjusted during render, not in an
  // effect, so the columns never flash before collapsing.
  const [wasBoardFull, setWasBoardFull] = useState(boardFull);
  if (wasBoardFull !== boardFull) {
    setWasBoardFull(boardFull);
    setVisibility(boardFull ? "detailOnly" : "all");
  }
  const half = width / 2;
  // SwiftUI caps the sidebar column a little short of half the window (~20pt on
  // the Duo). That's fine: the detail screens' own side padding (~38pt) already
  // keeps their content clear of the fold, so no extra inset is added.

  const selectView = useCallback((next: SplitViewKind) => {
    setSelection({ view: next });
  }, []);
  const openNote = useCallback((id: string) => setSelection({ view: "notes", noteId: id }), []);
  const openCard = useCallback((id: string) => setSelection({ view: "board", cardId: id }), []);

  // SwiftUI colours take hex; the accent is a #rrggbb token, so append alpha.
  const selectedRow = /^#[0-9a-f]{6}$/i.test(t.accent) ? `${t.accent}33` : t.accent;

  const row = (key: string, title: string, icon: SFSymbol, selected: boolean, onPress: () => void, count?: number) => (
    <Label
      key={key}
      title={title}
      systemImage={icon}
      modifiers={[
        // Rows select on tap with a drawn highlight: List's own selection binds
        // a Set, which on iPhone-idiom devices (the Duo) only selects in edit mode.
        padding({ horizontal: 4, vertical: 6 }),
        frame({ maxWidth: Infinity, alignment: "leading" }),
        contentShape(shapes.rectangle()),
        onTapGesture(onPress),
        ...(selected ? [background(selectedRow, shapes.roundedRectangle({ cornerRadius: 10 }))] : []),
        ...(count ? [badge(String(count))] : []),
      ]}
    />
  );

  const viewsPanel = (panelModifiers: ViewModifier[]) => (
      <List
        modifiers={[listStyle("sidebar"), ...panelModifiers]}
      >
        <Section title="Project">
          <Menu label={project?.name ?? "Choose a project"} systemImage="folder">
            {projects.map((p) => (
              <Button
                key={p.id}
                label={p.name}
                systemImage={p.id === projectId ? "checkmark" : "folder"}
                onPress={() => {
                  setSelection({ projectId: p.id, noteId: null, cardId: null });
                              }}
              />
            ))}
          </Menu>
          {progress && progress.total > 0 ? (
            <VStack alignment="leading" spacing={6} modifiers={[padding({ vertical: 4 })]}>
              <ProgressView value={progress.closed / progress.total} modifiers={[tint(t.accent)]} />
              <Text
                modifiers={[
                  font({ textStyle: "caption" }),
                  foregroundStyle({ type: "hierarchical", style: "secondary" }),
                ]}
              >
                {`${progress.closed} / ${progress.total} done · ${progress.open} open`}
              </Text>
            </VStack>
          ) : null}
        </Section>
        <Section title="Views">
          {VIEWS.map((v) =>
            row(
              v.id,
              v.title,
              v.icon,
              v.id === view,
              () => selectView(v.id),
              v.id === "notes" ? project?.noteCount : v.id === "board" ? project?.cardCount : undefined,
            ),
          )}
        </Section>
      </List>
  );

  if (!projectId) {
    return (
      <Host style={{ flex: 1 }}>
        <ContentUnavailableView title="No Projects" systemImage="folder" description="Sync a workspace to see its projects." />
      </Host>
    );
  }

  const listColumn = (
    extra: ViewModifier[] = [],
    leading: Parameters<typeof ChromeColumn>[0]["leading"] = [],
    menu?: Parameters<typeof ChromeColumn>[0]["titleMenu"],
  ) => (
    <ChromeColumn key={`${projectId}:${view}:${boardVersion}`} modifiers={extra} leading={leading} titleMenu={menu}>
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

  // Two-column layouts have no room for the project sidebar beside the list, so
  // its contents become the list's title menu: tap "Project ▾" for the views
  // and a project switcher. (Fewer buttons than a separate panel toggle.)
  const titleMenu = (
    <Menu label={`${project?.name ?? "Project"} · ${VIEWS.find((v) => v.id === view)?.title ?? ""}`}>
      {VIEWS.map((v) => (
        <Button
          key={v.id}
          label={v.title}
          systemImage={v.id === view ? "checkmark" : v.icon}
          onPress={() => selectView(v.id)}
        />
      ))}
      <Menu label="Switch project" systemImage="folder">
        {projects.map((p) => (
          <Button
            key={p.id}
            label={p.name}
            systemImage={p.id === projectId ? "checkmark" : "folder"}
            onPress={() => setSelection({ projectId: p.id, noteId: null, cardId: null })}
          />
        ))}
      </Menu>
    </Menu>
  );

  const detail = (
    <NavigationSplitView.Detail>
      {boardFull ? (
        <ChromeColumn key={`${projectId}:board`} titleMenu={titleMenu}>
          <View style={{ flex: 1, flexDirection: "row", overflow: "hidden" }}>
            <Animated.View layout={PREVIEW_LAYOUT} style={{ flex: 1 }}>
              <ProjectScreen
                key={boardVersion}
                nested
                projectId={projectId}
                view="board"
                onSelectView={selectView}
                onOpenNote={openNote}
                onOpenCard={openCard}
              />
            </Animated.View>
            {sel.cardId ? (
              <ChatPreviewPane
                preview={{ kind: "card", id: sel.cardId }}
                onClose={() => setSelection({ cardId: null })}
                onChanged={() => setBoardVersion((n) => n + 1)}
              />
            ) : null}
          </View>
        </ChromeColumn>
      ) : view === "overview" ? (
        <ChromeColumn key={`${projectId}:overview`}>
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
        <ChromeColumn key={`${projectId}:calendar`}>
          <ProjectCalendarScreen nested projectId={projectId} onOpenCard={openCard} />
        </ChromeColumn>
      ) : view === "notes" && sel.noteId ? (
        <ChromeColumn
          key={sel.noteId}
          leading={[{ key: "close", label: "Close note", icon: "xmark", onPress: () => setSelection({ noteId: null }) }]}
        >
          <NoteDetailScreen nested noteId={sel.noteId} onClose={() => setSelection({ noteId: null })} />
        </ChromeColumn>
      ) : (
        <ContentUnavailableView
          modifiers={[background(t.background)]}
          title="No Note Selected"
          systemImage="doc.text"
          description="Pick a note from the list."
        />
      )}
    </NavigationSplitView.Detail>
  );

  const splitModifiers = [tint(t.accent), onHingeChange((_, next) => setHinge(rememberHingeStatus(next.hinge?.status ?? null)))];

  // ── Wide iPad: three native columns ────────────────────────────────────────
  // Each layout gets its own Host key: switching between them (rotating an
  // iPad) must remount the columns — a hosted React Native view moved into a
  // different SwiftUI column otherwise renders blank.
  if (roomy) {
    return (
      <Host key="three-column" style={{ flex: 1 }}>
        <NavigationSplitView columnVisibility={visibility} onColumnVisibilityChange={setVisibility} modifiers={splitModifiers}>
          <NavigationSplitView.Sidebar>
            {viewsPanel([navigationTitle(workspaceName), navigationSplitViewColumnWidth({ min: 240, ideal: 270, max: 320 })])}
          </NavigationSplitView.Sidebar>
          {listView ? (
            <NavigationSplitView.Content>
              {listColumn([navigationSplitViewColumnWidth({ min: 280, ideal: 340, max: 420 })])}
            </NavigationSplitView.Content>
          ) : null}
          {detail}
        </NavigationSplitView>
      </Host>
    );
  }

  // ── Duo / narrower: two columns; views + projects in the title menu ────────
  // On a Duo the left column asks for exactly half the window in every posture.
  const leftWidth = hasHinge
    ? navigationSplitViewColumnWidth(half)
    : navigationSplitViewColumnWidth({ min: 300, ideal: 360, max: 440 });

  return (
    <Host key="two-column" style={{ flex: 1 }}>
      <NavigationSplitView
        // The system sidebar button collapses the list for a full-width item
        // (focus mode); views and projects live in the list's title menu.
        columnVisibility={visibility}
        onColumnVisibilityChange={setVisibility}
        modifiers={splitModifiers}
      >
        <NavigationSplitView.Sidebar>
          {listView ? (
            listColumn([leftWidth], [], titleMenu)
          ) : (
            viewsPanel([navigationTitle(workspaceName), leftWidth])
          )}
        </NavigationSplitView.Sidebar>
        {detail}
      </NavigationSplitView>
    </Host>
  );
}
