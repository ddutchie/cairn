import { useState } from "react";
import { useRouter } from "expo-router";
import {
  Button,
  DisclosureGroup,
  Label,
  List,
  Menu,
  Section,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import {
  background,
  contentShape,
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
import type { ProjectsTree, TreeNode } from "@/components/projects-tree";
import { getActiveSource } from "@/db";
import { haptics } from "@/haptics";
import { switchSource } from "@/sync/controller";
import { useSyncSources } from "@/sync/useSyncSources";
import { useSyncStatus } from "@/sync/useSyncStatus";
import { useTheme } from "@/theme";

/**
 * The projects tree as a real split-view sidebar column — the same model as
 * the list and detail columns, so fold/unfold never unmounts the navigation
 * hierarchy.
 *
 * A native column bar (workspace switcher as the title, sync/settings as
 * trailing icon buttons) above the tree list — the same Toolbar pattern the
 * `ChromeColumn` content columns use.
 */
export function ProjectsTreeSidebar({
  title,
  tree,
  onWorkspaceSwitched,
}: {
  /** Active workspace name (doubles as the switcher label). */
  title: string;
  tree: ProjectsTree;
  /** Called after the workspace switches so the owner reloads its data. */
  onWorkspaceSwitched: () => void;
}) {
  const t = useTheme();
  const router = useRouter();
  const { state: syncState, pending: syncPending } = useSyncStatus();
  const { sources, refresh } = useSyncSources({ mergeActive: true });
  const [projectId, view] = tree.selectedPath;
  // The open project starts expanded; others keep whatever the user chose.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [projectId]: true });
  const [seenProject, setSeenProject] = useState(projectId);
  if (seenProject !== projectId) {
    setSeenProject(projectId);
    setExpanded((e) => ({ ...e, [projectId]: true }));
  }

  const syncOffline = syncState === "offline";
  const syncTint = syncOffline ? t.textTertiary : syncPending > 0 ? t.warning : t.success;

  const selectedRow = /^#[0-9a-f]{6}$/i.test(t.accent) ? `${t.accent}33` : t.accent;
  const row = (p: TreeNode, v: TreeNode) => {
    const selected = p.id === projectId && v.id === view;
    return (
      <Label
        key={v.id}
        title={v.badge ? `${v.title}  ·  ${v.badge}` : v.title}
        systemImage={v.icon}
        modifiers={[
          padding({ horizontal: 4, vertical: 6 }),
          frame({ maxWidth: Infinity, alignment: "leading" }),
          contentShape(shapes.rectangle()),
          onTapGesture(() => tree.select([p.id, v.id])),
          ...(selected ? [background(selectedRow, shapes.roundedRectangle({ cornerRadius: 10 }))] : []),
        ]}
      />
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
        <Section>
          {tree.nodes.map((p) => (
            <DisclosureGroup
              key={p.id}
              isExpanded={expanded[p.id] ?? false}
              onIsExpandedChange={(next) => setExpanded((e) => ({ ...e, [p.id]: next }))}
            >
              <DisclosureGroup.Label>
                <Label title={p.title} systemImage={p.id === projectId ? "folder.fill" : "folder"} />
              </DisclosureGroup.Label>
              {(p.children ?? []).map((v) => row(p, v))}
            </DisclosureGroup>
          ))}
        </Section>
      </List>
      <Toolbar.Content>
        <ToolbarItem placement="topBarLeading">
          <Menu label={title} systemImage="folder">
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
        <ToolbarItem placement="topBarTrailing">
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
        <ToolbarItem placement="topBarTrailing">
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
