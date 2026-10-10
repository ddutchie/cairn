import { useEffect, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Host } from "@expo/ui";
import { DisclosureGroup, Label, List, ProgressView, Section, Text, VStack } from "@expo/ui/swift-ui";
import {
  background,
  contentShape,
  font,
  foregroundStyle,
  frame,
  listStyle,
  onTapGesture,
  padding,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ProjectsTree, TreeNode } from "@/components/projects-tree";
import { useTheme } from "@/theme";

/**
 * The in-app renderer of the projects tree (see projects-tree.ts): a panel that
 * slides over the left page — ending on the hinge on a Duo — instead of pushing
 * the columns across it. Used where the system tab sidebar isn't available:
 * the iPhone Duo (phone idiom never shows it) and the iPad as a fallback.
 */
export function ProjectsTreePanel({
  open,
  onClose,
  width,
  title,
  tree,
  progress,
}: {
  open: boolean;
  onClose: () => void;
  width: number;
  title: string;
  tree: ProjectsTree;
  /** The open project's task progress, shown above its views. */
  progress: { closed: number; total: number; open: number } | null;
}) {
  const t = useTheme();
  const [projectId, view] = tree.selectedPath;
  // The open project starts expanded; others keep whatever the user chose.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [projectId]: true });
  const [seenProject, setSeenProject] = useState(projectId);
  if (seenProject !== projectId) {
    setSeenProject(projectId);
    setExpanded((e) => ({ ...e, [projectId]: true }));
  }

  // Stays mounted until the slide-out finishes.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const progressValue = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    progressValue.set(
      withTiming(open ? 1 : 0, { duration: open ? 260 : 200, easing: Easing.out(Easing.cubic) }, (done) => {
        if (done && !open) runOnJS(setShown)(false);
      }),
    );
  }, [open, progressValue]);
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: (progressValue.get() - 1) * width }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progressValue.get() }));

  if (!shown) return null;

  // SwiftUI colours take hex; the accent is a #rrggbb token, so append alpha.
  const selectedRow = /^#[0-9a-f]{6}$/i.test(t.accent) ? `${t.accent}33` : t.accent;
  const row = (p: TreeNode, v: TreeNode) => {
    const selected = p.id === projectId && v.id === view;
    return (
      <Label
        key={v.id}
        title={v.badge ? `${v.title}  ·  ${v.badge}` : v.title}
        systemImage={v.icon}
        modifiers={[
          // Tap + drawn highlight: List selection only works in edit mode on
          // iPhone-idiom devices.
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
    <>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close projects" />
      </Animated.View>
      <Animated.View style={[styles.panel, { width, backgroundColor: t.background }, panelStyle]}>
        <Host style={{ flex: 1 }}>
          <List modifiers={[listStyle("sidebar"), tint(t.accent)]}>
            <Section title={title}>
              {tree.nodes.map((p) => (
                <DisclosureGroup
                  key={p.id}
                  isExpanded={expanded[p.id] ?? false}
                  onIsExpandedChange={(next) => setExpanded((e) => ({ ...e, [p.id]: next }))}
                >
                  <DisclosureGroup.Label>
                    <Label title={p.title} systemImage={p.id === projectId ? "folder.fill" : "folder"} />
                  </DisclosureGroup.Label>
                  {p.id === projectId && progress && progress.total > 0 ? (
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
                  {(p.children ?? []).map((v) => row(p, v))}
                </DisclosureGroup>
              ))}
            </Section>
          </List>
        </Host>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(0,0,0,0.25)" },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 4, height: 0 },
  },
});
