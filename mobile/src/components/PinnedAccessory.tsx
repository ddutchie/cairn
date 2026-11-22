import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { BarChart3, Network, RefreshCw, Sun, Users } from "lucide-react-native";
import { WORKSPACE_TOOLS, liveLine, type ToolId } from "@/lib/workspace-tools";
import { showAccessoryMenu } from "@/lib/pin-menu";
import { useTheme, type as typeScale } from "@/theme";

const ICONS: Record<ToolId, typeof Users> = { today: Sun, people: Users, graph: Network, usage: BarChart3, sync: RefreshCw };

/**
 * The tool the user pinned from the Workspace tab, shown above the tab bar.
 * It renders twice (regular and inline when the bar minimises) with separate
 * state, so it reads everything from props and the store, and stays light.
 * Tap opens the tool; press and hold switches it or hides it.
 */
export function PinnedAccessory({ tool }: { tool: ToolId }) {
  const t = useTheme();
  const router = useRouter();
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const meta = WORKSPACE_TOOLS[tool];
  const Icon = ICONS[tool];
  return (
    <Pressable
      style={s.root}
      onPress={() => router.push(meta.href, { withAnchor: true })}
      onLongPress={() => showAccessoryMenu(tool)}
      accessibilityRole="button"
      accessibilityLabel={`${meta.title}, ${liveLine(tool)}`}
      accessibilityHint="Press and hold to change or hide"
    >
      <Icon size={18} color={t.accent} />
      <View style={s.text}>
        <Text style={[typeScale.control, { color: t.textPrimary }]} numberOfLines={1}>{meta.title}</Text>
        {placement === "inline" ? null : (
          <Text style={[typeScale.caption, { color: t.textTertiary }]} numberOfLines={1}>{liveLine(tool)}</Text>
        )}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 },
  text: { flexShrink: 1 },
});
