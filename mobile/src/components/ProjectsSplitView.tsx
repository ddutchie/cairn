import { useState } from "react";
import { Host } from "@expo/ui";
import {
  ContentUnavailableView,
  Label,
  List,
  NavigationSplitView,
  type NavigationSplitViewColumn,
  type NavigationSplitViewVisibility,
  RNHostView,
  Section,
} from "@expo/ui/swift-ui";
import {
  badge,
  contentShape,
  frame,
  background,
  padding,
  listStyle,
  onTapGesture,
  shapes,
  navigationSplitViewColumnWidth,
  navigationTitle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ProjectSummary } from "@/db/queries";
import { ProjectScreen } from "@/screens/ProjectScreen";
import { useTheme } from "@/theme";

/**
 * SPIKE — Projects as a native SwiftUI split view for wide windows (unfolded
 * iPhone Duo, iPad). The sidebar lists projects; the detail column hosts the
 * React Native ProjectScreen. Selection lives in React state, so folding /
 * unfolding keeps the open project (pattern from expo-ui-examples' split view).
 */
export function ProjectsSplitView({
  projects,
  workspaceName,
}: {
  projects: ProjectSummary[];
  workspaceName: string;
}) {
  const t = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const [compactColumn, setCompactColumn] = useState<NavigationSplitViewColumn>("sidebar");
  const [visibility, setVisibility] = useState<NavigationSplitViewVisibility>("all");
  const selected = projects.find((p) => p.id === selectedId);
  // SwiftUI colours take hex; the accent is a #rrggbb token, so append alpha.
  const selectedRow = /^#[0-9a-f]{6}$/i.test(t.accent) ? `${t.accent}33` : t.accent;

  return (
    <Host style={{ flex: 1 }}>
      <NavigationSplitView
        preferredCompactColumn={compactColumn}
        onPreferredCompactColumnChange={setCompactColumn}
        columnVisibility={visibility}
        onColumnVisibilityChange={setVisibility}
        modifiers={[tint(t.accent)]}
      >
        <NavigationSplitView.Sidebar>
          {/* Rows select on tap and draw their own highlight. List's built-in
              selection binds a Set (multi-select), which on an iPhone-idiom
              device — the Duo included — only selects in edit mode. */}
          <List
            modifiers={[
              listStyle("sidebar"),
              navigationTitle(workspaceName),
              navigationSplitViewColumnWidth({ min: 240, ideal: 280, max: 340 }),
            ]}
          >
            <Section title="Projects">
              {projects.map((p) => (
                <Label
                  key={p.id}
                  title={p.name}
                  systemImage="folder"
                  modifiers={[
                    padding({ horizontal: 4, vertical: 6 }),
                    frame({ maxWidth: Infinity, alignment: "leading" }),
                    contentShape(shapes.rectangle()),
                    onTapGesture(() => {
                      setSelectedId(p.id);
                      setCompactColumn("detail");
                    }),
                    ...(p.id === selectedId
                      ? [background(selectedRow, shapes.roundedRectangle({ cornerRadius: 10 }))]
                      : []),
                    ...(p.cardCount > 0 ? [badge(String(p.cardCount))] : []),
                  ]}
                />
              ))}
            </Section>
          </List>
        </NavigationSplitView.Sidebar>

        <NavigationSplitView.Detail>
          {selected ? (
            <RNHostView>
              {/* Keyed so switching project resets segment / scroll state. */}
              <ProjectScreen key={selected.id} nested projectId={selected.id} />
            </RNHostView>
          ) : (
            <ContentUnavailableView
              title="No Project Selected"
              systemImage="folder"
              description="Pick a project from the sidebar."
            />
          )}
        </NavigationSplitView.Detail>
      </NavigationSplitView>
    </Host>
  );
}
