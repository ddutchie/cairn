import { useCallback } from "react";
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
  listStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  onTapGesture,
  padding,
  scrollContentBackground,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ProjectsList } from "@/components/projects-tree";
import { ICON_CAIRN } from "@/components/toolbar-icons";
import { getActiveSource } from "@/db";
import { haptics } from "@/haptics";
import { switchSource } from "@/sync/controller";
import { useSyncSources } from "@/sync/useSyncSources";
import { useSyncStatus } from "@/sync/useSyncStatus";
import { useTheme } from "@/theme";

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
}: {
  /** Active workspace name (doubles as the switcher label). */
  title: string;
  list: ProjectsList;
  /** Called after the workspace switches so the owner reloads its data. */
  onWorkspaceSwitched: () => void;
}) {
  const t = useTheme();
  const router = useRouter();
  const { state: syncState, pending: syncPending } = useSyncStatus();
  const { sources, refresh } = useSyncSources({ mergeActive: true });
  // Discover workspaces whenever the sidebar shows: sync never scans for new
  // ones, and without a scan the switcher menu only knows the active workspace.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const syncOffline = syncState === "offline";
  const syncTint = syncOffline ? t.textTertiary : syncPending > 0 ? t.warning : t.success;

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
        {/* Status stays visible longest (Apple: badges/status); Appearance
            is rare, so it is the first to fold into the overflow menu. */}
        <ToolbarItem placement="topBarTrailing" visibilityPriority="high">
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
        <ToolbarItem placement="topBarTrailing" visibilityPriority="low">
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
