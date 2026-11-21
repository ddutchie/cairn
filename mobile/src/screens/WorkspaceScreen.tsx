import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter, type Href } from "expo-router";
import { Network, Palette, Pin, RefreshCw, Sparkles, Users, Wrench } from "lucide-react-native";
import type { ReactNode } from "react";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { PINNABLE, WORKSPACE_TOOLS, liveLine, usePinnedTool, type ToolId } from "@/lib/workspace-tools";
import { showPinMenu } from "@/lib/pin-menu";
import { useTheme, type as typeScale, type Theme } from "@/theme";

const ICONS: Record<ToolId, typeof Users> = { people: Users, graph: Network, sync: RefreshCw };

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

  const load = useCallback(() => {
    setLines(Object.fromEntries(PINNABLE.map((id) => [id, liveLine(id)])));
  }, []);
  useRefreshOnFocus(load);

  const tools: Row[] = (["people", "graph"] as ToolId[]).map((id) => ({
    key: id, title: WORKSPACE_TOOLS[id].title, line: lines[id] ?? WORKSPACE_TOOLS[id].blurb,
    href: WORKSPACE_TOOLS[id].href, icon: ICONS[id], tool: id,
  }));
  const settings: Row[] = [
    { key: "sync", title: "Sync", line: lines.sync ?? WORKSPACE_TOOLS.sync.blurb, href: WORKSPACE_TOOLS.sync.href, icon: ICONS.sync, tool: "sync" },
    { key: "ai", title: "AI settings", line: "Provider, model, keys and usage", href: "/settings/ai" as Href, icon: Sparkles },
    { key: "tools", title: "Tools and services", line: "Connectors the assistant can use", href: "/settings/tools" as Href, icon: Wrench },
    { key: "appearance", title: "Appearance", line: "Theme and text size", href: "/settings/appearance" as Href, icon: Palette },
  ];

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
        <Text style={s.section}>Tools</Text>
        {tools.map(renderRow)}
        <Text style={s.section}>Settings</Text>
        {settings.map(renderRow)}
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
