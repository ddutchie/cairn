import { useCallback, useMemo, useState } from "react";
import { ActionSheetIOS, Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect, useRouter, type Href } from "expo-router";
import { BarChart3, FolderOpen, Network, Pin, RefreshCw, Settings, Users } from "lucide-react-native";
import type { ReactNode } from "react";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { PINNABLE, WORKSPACE_TOOLS, liveLine, usePinnedTool, type ToolId } from "@/lib/workspace-tools";
import { showPinMenu } from "@/lib/pin-menu";
import { getActiveSource } from "@/db";
import { switchSource } from "@/sync/controller";
import { useSyncSources } from "@/sync/useSyncSources";
import { useTheme, type as typeScale, type Theme } from "@/theme";

const ICONS: Record<ToolId, typeof Users> = { people: Users, graph: Network, usage: BarChart3, sync: RefreshCw };

type Row = { key: string; title: string; line: string; href: Href; icon: typeof Users; tool?: ToolId };

/**
 * The Workspace tab: a home for the things that are not the daily four. Each row
 * says what is in it, like the desktop sidebar's Workspace group. Press and hold
 * a row to show that tool above the tab bar.
 */
export function WorkspaceScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const pinned = usePinnedTool();
  const [lines, setLines] = useState<Record<string, string>>({});
  // The workspace switcher lives here (a tab-root header can't carry it on every layout).
  const [active, setActive] = useState<string | null>(() => getActiveSource());
  const { sources, refresh } = useSyncSources({ mergeActive: true });
  useFocusEffect(useCallback(() => { setActive(getActiveSource()); void refresh(); }, [refresh]));
  const activeName = sources.find((x) => x.workspaceId === active)?.name ?? "This workspace";
  const pickWorkspace = () => {
    const names = sources.map((x) => x.name || "Untitled");
    const pick = (i: number) => {
      const next = sources[i];
      if (!next || next.workspaceId === active) return;
      switchSource(next.workspaceId);
      setActive(next.workspaceId);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title: "Switch workspace", options: [...names, "Cancel"], cancelButtonIndex: names.length }, pick);
    } else {
      Alert.alert("Switch workspace", undefined, [...names.map((n, i) => ({ text: n, onPress: () => pick(i) })), { text: "Cancel", style: "cancel" as const }]);
    }
  };

  const load = useCallback(() => {
    setLines(Object.fromEntries(PINNABLE.map((id) => [id, liveLine(id)])));
  }, []);
  useRefreshOnFocus(load);

  const tools: Row[] = (["people", "graph"] as ToolId[]).map((id) => ({
    key: id, title: WORKSPACE_TOOLS[id].title, line: lines[id] ?? WORKSPACE_TOOLS[id].blurb,
    href: WORKSPACE_TOOLS[id].href, icon: ICONS[id], tool: id,
  }));
  const usage: Row = { key: "usage", title: "Usage", line: lines.usage ?? WORKSPACE_TOOLS.usage.blurb, href: WORKSPACE_TOOLS.usage.href, icon: ICONS.usage, tool: "usage" };
  const settings: Row = { key: "settings", title: "Settings", line: "Appearance, AI, tools and sync", href: "/workspace/settings" as Href, icon: Settings };

  const renderRow = (r: Row): ReactNode => {
    const isPinned = r.tool != null && r.tool === pinned;
    const Icon = r.icon;
    return (
      <PressableScale
        key={r.key}
        style={s.row}
        onPress={() => router.push(r.href)}
        onLongPress={r.tool ? () => showPinMenu(r.tool!, isPinned) : undefined}
        accessibilityLabel={`${r.title}, ${r.line}${isPinned ? ", shown above the tab bar" : ""}`}
        accessibilityHint={r.tool ? "Press and hold to show it above the tab bar" : undefined}
      >
        <View style={s.iconWrap}><Icon size={18} color={t.accent} /></View>
        <View style={s.body}>
          <Text style={s.title} numberOfLines={1}>{r.title}</Text>
          <Text style={s.line} numberOfLines={2}>{r.line}</Text>
        </View>
        {isPinned ? <Pin size={14} color={t.accent} /> : null}
        <Text style={s.chevron}>›</Text>
      </PressableScale>
    );
  };

  return (
    <TabScreen>
      <Stack.Screen options={{ title: "Workspace" }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={s.list}>
        <PressableScale
          style={s.row}
          onPress={pickWorkspace}
          disabled={sources.length < 2}
          accessibilityLabel={`Workspace, ${activeName}${sources.length > 1 ? ", switch" : ""}`}
        >
          <View style={s.iconWrap}><FolderOpen size={18} color={t.accent} /></View>
          <View style={s.body}>
            <Text style={s.title} numberOfLines={1}>{activeName}</Text>
            <Text style={s.line} numberOfLines={1}>{sources.length > 1 ? "Switch workspace" : "Your workspace"}</Text>
          </View>
          {sources.length > 1 ? <Text style={s.chevron}>›</Text> : null}
        </PressableScale>
        <Text style={s.section}>Tools</Text>
        {tools.map(renderRow)}
        {renderRow(usage)}
        <Text style={s.section}>Settings</Text>
        {renderRow(settings)}
        <Text style={s.hint}>Press and hold a tool to show it above the tab bar.</Text>
      </ScrollView>
    </TabScreen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { padding: 12, paddingBottom: 120 },
    section: { ...typeScale.label, color: t.textTertiary, marginTop: 14, marginBottom: 8, marginLeft: 4 },
    row: {
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    iconWrap: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: t.surface2 },
    body: { flex: 1, gap: 2 },
    title: { ...typeScale.control, color: t.textPrimary },
    line: { ...typeScale.caption, color: t.textTertiary },
    chevron: { fontSize: 20, color: t.textTertiary },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 14, marginLeft: 4 },
  });
}
