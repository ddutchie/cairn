import { useCallback, useState } from "react";
import { Image as RNImage, type ImageSourcePropType } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Button,
  HStack,
  Image,
  List,
  Menu,
  RNHostView,
  Section,
  Text,
  Toolbar,
  ToolbarItem,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  background,
  contentShape,
  font,
  foregroundStyle,
  frame,
  listRowSeparator,
  listStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  onTapGesture,
  padding,
  scrollContentBackground,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { CairnStack } from "@/components/CairnStack";
import { WorkspaceProgressHeader } from "@/components/WorkspaceProgressHeader";
import { getWorkspaceProgress, type WorkspaceProgress } from "@/db/queries";
import type { ProjectsList } from "@/components/projects-tree";
import { useRecentStones } from "@/gamification/useRecentStones";
import { ICON_CAIRN } from "@/components/toolbar-icons";
import { getActiveSource } from "@/db";
import { useTightSideRail } from "@/lib/layout";
import { useRefreshOnFocus, useSyncStatus } from "@/sync/useSyncStatus";
import { haptics } from "@/haptics";
import { switchSource } from "@/sync/controller";
import { useSyncSources } from "@/sync/useSyncSources";
import { useTheme } from "@/theme";

/**
 * The cairn stack at the top of the sidebar is built but switched off: on device it
 * read as a pile of grey pills rather than stones. Flip this on once the stones are
 * redesigned (see docs/plans/mobile-capture-and-widgets.md, "Revisit: cairn stack").
 */
const SHOW_CAIRN_STACK = false;

/**
 * The projects list as a real split-view sidebar column — the same model as
 * the project and item columns, so fold/unfold never unmounts the navigation
 * hierarchy. Flat: it only chooses the project (a project's views are the
 * segmented control in its own column).
 *
 * A native column bar (workspace switcher as the title, sync/settings as
 * trailing icon buttons) above the list — the same Toolbar pattern the
 * `ChromeColumn` content columns use.
 */
export function ProjectsTreeSidebar({
  title,
  list,
  onWorkspaceSwitched,
  onOpenNote,
  refreshKey,
}: {
  /** Active workspace name (doubles as the switcher label). */
  title: string;
  list: ProjectsList;
  /** Called after the workspace switches so the owner reloads its data. */
  onWorkspaceSwitched: () => void;
  /** Open a note in the split view (tapping a stone). Passed in, not imported: the split view imports this file. */
  onOpenNote: (projectId: string, noteId: string) => void;
  /**
   * Bumped when tasks change elsewhere (e.g. the detail column saves a card)
   * so the workspace progress re-reads — the project list itself only refreshes
   * on focus / sync.
   */
  refreshKey?: number;
}) {
  const t = useTheme();
  const router = useRouter();
  const hideTrailingActions = useTightSideRail();
  // Tight rail: trailing buttons collapse into the system "..." overflow menu
  // (secondaryAction) — one pill above the 5-tab rail. Roomy layouts keep them
  // inline with their overflow priorities. Placement is the only thing that
  // differs, so each button is written once below.
  const trailingItem = (priority: "high" | "low") =>
    hideTrailingActions
      ? ({ placement: "secondaryAction" } as const)
      : ({ placement: "topBarTrailing", visibilityPriority: priority } as const);
  const { state: syncState, pending: syncPending } = useSyncStatus();
  const { sources, refresh } = useSyncSources({ mergeActive: true });
  // Discover workspaces whenever the sidebar shows: sync never scans for new
  // ones, and without a scan the switcher menu only knows the active workspace.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const { inputs: stones, newestId } = useRecentStones(SHOW_CAIRN_STACK);
  const syncOffline = syncState === "offline";
  const syncTint = syncOffline ? t.textTertiary : syncPending > 0 ? t.warning : t.success;

  // Workspace-wide progress for the header card above the project list. Read
  // here (not passed in) so focus / sync / task-save refreshes stay local to
  // the sidebar; null when the DB isn't ready yet.
  const [progress, setProgress] = useState<WorkspaceProgress | null>(() => {
    try {
      return getWorkspaceProgress();
    } catch {
      return null;
    }
  });
  const loadProgress = useCallback(() => {
    try {
      setProgress(getWorkspaceProgress());
    } catch {
      setProgress(null);
    }
  }, []);
  useRefreshOnFocus(loadProgress);
  // Task saves in the detail column bump refreshKey (the list itself only
  // refreshes on focus / sync); a workspace switch changes the title/rows.
  // Deps intentionally include refreshKey/title/row-count: re-running the focus
  // effect on those changes is what refreshes the header while already focused.
  /* eslint-disable react-hooks/exhaustive-deps */
  useFocusEffect(
    useCallback(() => {
      loadProgress();
    }, [loadProgress, refreshKey, title, list.nodes.length]),
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  const selectedRow = /^#[0-9a-f]{6}$/i.test(t.accent) ? `${t.accent}33` : t.accent;
  const row = (p: ProjectsList["nodes"][number]) => {
    const selected = p.id === list.selectedId;
    return (
      <HStack
        key={p.id}
        spacing={12}
        modifiers={[
          padding({ horizontal: 4, vertical: 6 }),
          frame({ maxWidth: Infinity, alignment: "leading" }),
          contentShape(shapes.rectangle()),
          onTapGesture(() => list.select(p.id)),
          // A tap gesture alone isn't announced as a button; the tint isn't
          // announced as selection. (A Button would restyle the row.)
          accessibilityAddTraits(selected ? ["isButton", "isSelected"] : ["isButton"]),
          ...(selected ? [background(selectedRow, shapes.roundedRectangle({ cornerRadius: 10 }))] : []),
        ]}
      >
        <Image systemName={p.icon} color={t.accent} size={20} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: "body", weight: "medium" })]}>{p.title}</Text>
          <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle({ type: "hierarchical", style: "secondary" })]}>
            {p.subtitle}
          </Text>
        </VStack>
      </HStack>
    );
  };

  return (
    // Inline titles: a large title costs too much height in a narrow column.
    <Toolbar
      modifiers={[
        navigationTitle("Projects"),
        navigationBarTitleDisplayMode("inline"),
        // Fill the column, safe areas included, with the page colour.
        background(t.background),
      ]}
    >
      <List modifiers={[listStyle("sidebar"), tint(t.accent), scrollContentBackground("hidden"), background(t.background)]}>
        {SHOW_CAIRN_STACK && stones.length > 0 && (
          <Section modifiers={[listRowSeparator("hidden")]}>
            <HStack modifiers={[frame({ maxWidth: Infinity, alignment: "center" }), padding({ vertical: 4 })]}>
              <RNHostView matchContents>
                <CairnStack
                  inputs={stones}
                  newestId={newestId}
                  onOpen={({ projectId, id }) => onOpenNote(projectId, id)}
                />
              </RNHostView>
            </HStack>
          </Section>
        )}
        {progress && (progress.totalCards > 0 || progress.totalNotes > 0) && (
          <WorkspaceProgressHeader progress={progress} />
        )}
        <Section>{list.nodes.map(row)}</Section>
      </List>
      <Toolbar.Content>
        <ToolbarItem placement="topBarLeading">
          {/* Not "folder": that's the Projects tab and every project row. */}
          {/* The Cairn glyph, like the old Projects header switcher. */}
          <Menu
            label={
              <RNHostView matchContents>
                <RNImage
                  source={ICON_CAIRN as ImageSourcePropType}
                  tintColor={t.accent}
                  style={{ width: 22, height: 22 }}
                  accessibilityLabel={`Switch workspace, ${title}`}
                />
              </RNHostView>
            }
          >
            {sources.map((s) => (
              <Button
                key={s.workspaceId}
                label={s.workspaceId === getActiveSource() ? `✓ ${s.name ?? "Workspace"}` : (s.name ?? "Workspace")}
                onPress={() => {
                  if (s.workspaceId === getActiveSource()) return;
                  switchSource(s.workspaceId);
                  void refresh();
                  onWorkspaceSwitched();
                }}
              />
            ))}
          </Menu>
        </ToolbarItem>
        {/* Duo tight rail (folded landscape): all three actions fold into the
            system "..." overflow menu (secondaryAction) so the rail gets a
            single "..." button above the 5-tab pill. Roomy layouts (portrait,
            unfolded, regular iPhones) keep all three buttons inline. Only the
            placement differs — each button is written once. */}
        <ToolbarItem {...trailingItem("high")}>
          <Button
            label="Capture"
            systemImage="tray.and.arrow.down"
            onPress={() => {
              haptics.selection();
              router.push("/capture");
            }}
          />
        </ToolbarItem>
        {/* Status stays visible longest (Apple: badges/status); Appearance
            is rare, so it is the first to fold into the overflow menu. */}
        <ToolbarItem {...trailingItem("high")}>
          <Button
            label="Sync status"
            systemImage="arrow.triangle.2.circlepath"
            modifiers={[tint(syncTint)]}
            onPress={() => {
              haptics.selection();
              router.push("/sync");
            }}
          />
        </ToolbarItem>
        <ToolbarItem {...trailingItem("low")}>
          <Button
            label="Appearance settings"
            systemImage="gear"
            onPress={() => {
              haptics.selection();
              router.push("/settings/appearance");
            }}
          />
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}
