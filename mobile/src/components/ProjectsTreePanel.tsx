import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { Cloud, CloudOff, RefreshCw, Settings } from "lucide-react-native";
import { Host } from "@expo/ui";
import { DisclosureGroup, Label, List, Section } from "@expo/ui/swift-ui";
import {
  background,
  contentShape,
  frame,
  listStyle,
  onTapGesture,
  scrollContentBackground,
  padding,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ProjectsTree, TreeNode } from "@/components/projects-tree";
import { useSyncStatus } from "@/sync/useSyncStatus";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale } from "@/theme";

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
  card,
}: {
  open: boolean;
  onClose: () => void;
  width: number;
  title: string;
  tree: ProjectsTree;
  /** The open project at a glance (ProjectCard), above the tree. */
  card?: ReactNode;
}) {
  const t = useTheme();
  const router = useRouter();
  const { state: syncState, pending: syncPending } = useSyncStatus();
  // Workspace-level actions live here because the narrow Projects header
  // (which owns sync + settings on the phone) never renders in split-view
  // mode — the panel is reachable from every column via the folder button.
  const syncOffline = syncState === "offline";
  const syncActive = syncState === "syncing" || syncPending > 0;
  const SyncIcon = syncOffline ? CloudOff : syncActive ? RefreshCw : Cloud;
  const syncTint = syncOffline ? t.textTertiary : syncPending > 0 ? t.warning : t.success;
  const goSync = () => {
    haptics.selection();
    onClose();
    router.push("/sync");
  };
  const goSettings = () => {
    haptics.selection();
    onClose();
    router.push("/settings/appearance");
  };
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
        <View style={styles.topBar}>
          <Text style={[styles.title, { color: t.textPrimary }]} numberOfLines={1}>
            {title}
          </Text>
          <Pressable onPress={goSync} hitSlop={10} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Sync status" accessibilityHint="Opens sync details">
            <SyncIcon size={20} color={syncTint} />
          </Pressable>
          <Pressable onPress={goSettings} hitSlop={10} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Appearance settings">
            <Settings size={20} color={t.textSecondary} />
          </Pressable>
        </View>
        {card ? <View style={styles.cardSlot}>{card}</View> : null}
        <Host style={{ flex: 1 }}>
          {/* The page colour behind the list too, so it joins the card above. */}
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
        </Host>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: { ...typeScale.title, fontWeight: "700", flex: 1 },
  iconBtn: { padding: 6 },
  cardSlot: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
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
