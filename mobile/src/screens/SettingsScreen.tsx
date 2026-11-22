import { useMemo, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import Constants from "expo-constants";
import { Database, Info, PenLine, Palette, RefreshCw, Sparkles, Tags, Wrench } from "lucide-react-native";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { useTheme, type as typeScale, type Theme } from "@/theme";

type Row = { key: string; title: string; line: string; href: Href; icon: typeof Palette };
type Group = { title: string; rows: Row[] };

/** Same groups, same names and same order as the desktop Settings rail (App, AI, Extensions, Data). */
const GROUPS: Group[] = [
  { title: "App", rows: [{ key: "appearance", title: "Appearance", line: "Theme and text size", href: "/settings/appearance" as Href, icon: Palette }] },
  {
    title: "AI",
    rows: [
      { key: "ai", title: "AI settings", line: "Provider, model and keys", href: "/settings/ai" as Href, icon: Sparkles },
      { key: "style", title: "Writing style", line: "How chat drafts in your voice", href: "/settings/style" as Href, icon: PenLine },
    ],
  },
  { title: "Extensions", rows: [{ key: "tools", title: "Tools and services", line: "Connectors the assistant can use", href: "/settings/tools" as Href, icon: Wrench }] },
  {
    title: "Data",
    rows: [
      { key: "tags", title: "Tags", line: "Rename, recolour and delete", href: "/settings/tags" as Href, icon: Tags },
      { key: "data", title: "Data", line: "Storage and counts on this phone", href: "/settings/data" as Href, icon: Database },
      { key: "sync", title: "Sync", line: "Devices and the shared folder", href: "/settings/sync" as Href, icon: RefreshCw },
    ],
  },
];

/** The one home for settings on mobile: the first screen of the settings modal (`app/settings`). */
export function SettingsScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const version = Constants.expoConfig?.version ?? "";
  const renderRow = (r: Row): ReactNode => {
    const Icon = r.icon;
    return (
      <PressableScale key={r.key} style={s.row} onPress={() => router.push(r.href)} accessibilityLabel={`${r.title}, ${r.line}`}>
        <View style={s.iconWrap}><Icon size={18} color={t.accent} /></View>
        <View style={s.body}>
          <Text style={s.title} numberOfLines={1}>{r.title}</Text>
          <Text style={s.line} numberOfLines={2}>{r.line}</Text>
        </View>
        <Text style={s.chevron}>›</Text>
      </PressableScale>
    );
  };
  return (
    <TabScreen>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={s.list}>
        {GROUPS.map((g) => (
          <View key={g.title}>
            <Text style={s.section}>{g.title}</Text>
            {g.rows.map(renderRow)}
          </View>
        ))}
        {/* About: the version, as on desktop's About page (no tour or what's new on the phone yet). */}
        <Text style={s.section}>About</Text>
        <View style={s.row} accessible accessibilityLabel={`Cairn, version ${version}`}>
          <View style={s.iconWrap}><Info size={18} color={t.accent} /></View>
          <View style={s.body}>
            <Text style={s.title} numberOfLines={1}>Cairn</Text>
            <Text style={s.line} numberOfLines={1}>Version {version}</Text>
          </View>
        </View>
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
  });
}
