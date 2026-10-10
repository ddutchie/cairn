import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";
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
  ZStack,
} from "@expo/ui/swift-ui";
import {
  animation,
  Animation,
  background,
  badge,
  contentShape,
  font,
  foregroundStyle,
  frame,
  listStyle,
  navigationSplitViewColumnWidth,
  navigationTitle,
  offset,
  onHingeChange,
  onTapGesture,
  padding,
  shadow,
  shapes,
  tint,
  type HingeStatus,
  type ViewModifier,
} from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";
import { listCards, listColumns, type ProjectSummary } from "@/db/queries";
import { ProjectScreen, type ProjectTab } from "@/screens/ProjectScreen";
import { NoteDetailScreen } from "@/screens/NoteDetailScreen";
import { CardDetailScreen } from "@/screens/CardDetailScreen";
import { ProjectCalendarScreen } from "@/screens/ProjectCalendarScreen";
import { ChromeColumn } from "@/components/screen-chrome";
import { isDoneColumn } from "@/gamification/rewards";
import { useTheme } from "@/theme";

/**
 * Projects on wide windows (unfolded iPhone Duo, iPad), laid out like desktop:
 *
 *   sidebar  — project switcher + progress, and the project's views
 *   content  — the view's list (notes tree, board)
 *   detail   — the open note / task
 *
 * Overview and Calendar have no list → item shape, so they drop the content
 * column and fill the detail. Half open on a Duo, the sidebar hides and the
 * content column is sized to end on the hinge: list on one page, item on the
 * other.
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
const PANEL_WIDTH = 290;

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
  const listView = view === "notes" || view === "board";

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
  const [hinge, setHinge] = useState<HingeStatus | null>(null);
  const halfOpen = hinge === "partiallyOpen";
  // Three native columns need room (wide iPads). Narrower — an unfolded Duo
  // is ~950pt — shows two: list | item, with the project + views panel sliding
  // over the list instead of squeezing both columns across the fold.
  const roomy = width >= ALL_COLUMNS_MIN_WIDTH;
  const [visibility, setVisibility] = useState<NavigationSplitViewVisibility>("all");
  const [panelOpen, setPanelOpen] = useState(false);
  const half = width / 2;

  const selectView = useCallback((next: SplitViewKind) => {
    setSelection({ view: next });
    setPanelOpen(false);
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
                  setPanelOpen(false);
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

  const listColumn = (extra: ViewModifier[] = []) => (
    <ChromeColumn key={`${projectId}:${view}:${boardVersion}`} modifiers={extra}>
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

  const detail = (
    <NavigationSplitView.Detail>
      {view === "overview" ? (
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
        <ChromeColumn key={sel.noteId}>
          <NoteDetailScreen nested noteId={sel.noteId} onClose={() => setSelection({ noteId: null })} />
        </ChromeColumn>
      ) : view === "board" && sel.cardId ? (
        <ChromeColumn key={sel.cardId}>
          <CardDetailScreen
            cardId={sel.cardId}
            onClose={() => setSelection({ cardId: null })}
            onChanged={() => setBoardVersion((n) => n + 1)}
          />
        </ChromeColumn>
      ) : (
        <ContentUnavailableView
          modifiers={[background(t.background)]}
          title={view === "notes" ? "No Note Selected" : "No Task Selected"}
          systemImage={view === "notes" ? "doc.text" : "checklist"}
          description={view === "notes" ? "Pick a note from the list." : "Pick a task from the board."}
        />
      )}
    </NavigationSplitView.Detail>
  );

  const splitModifiers = [tint(t.accent), onHingeChange((_, next) => setHinge(next.hinge?.status ?? null))];

  // ── Wide iPad: three native columns ────────────────────────────────────────
  if (roomy) {
    return (
      <Host style={{ flex: 1 }}>
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

  // ── Duo / narrower: two columns, views panel slides over the list ──────────
  // Half open, the left column is exactly half the window so the fold falls
  // between the columns.
  const leftWidth = halfOpen
    ? navigationSplitViewColumnWidth(half)
    : navigationSplitViewColumnWidth({ min: 300, ideal: 360, max: 440 });

  return (
    <Host style={{ flex: 1 }}>
      <NavigationSplitView
        // The list column always stays. The system sidebar button asks to hide
        // it; we never apply that and toggle the views panel over the list.
        columnVisibility="all"
        onColumnVisibilityChange={(next) => {
          if (next !== "all" && listView) setPanelOpen((o) => !o);
        }}
        modifiers={splitModifiers}
      >
        <NavigationSplitView.Sidebar>
          {listView ? (
            <ZStack alignment="topLeading" modifiers={[leftWidth]}>
              {listColumn()}
              {viewsPanel([
                frame({ width: PANEL_WIDTH }),
                frame({ maxHeight: Infinity, alignment: "top" }),
                background(t.surface),
                shadow({ radius: panelOpen ? 16 : 0, x: 4 }),
                offset({ x: panelOpen ? 0 : -(PANEL_WIDTH + 24) }),
                animation(Animation.spring({ duration: 0.35 }), panelOpen),
              ])}
            </ZStack>
          ) : (
            viewsPanel([navigationTitle(workspaceName), leftWidth])
          )}
        </NavigationSplitView.Sidebar>
        {detail}
      </NavigationSplitView>
    </Host>
  );
}
