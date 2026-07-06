import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUpCircle } from "lucide-react-native";
import { useTheme, elevation } from "@/theme";
import { useAppUpdates } from "@/updates/useAppUpdates";

/**
 * A dismissible-by-action banner that appears when an OTA update has been
 * downloaded and is ready to apply. Tapping "Restart" reloads into the new JS
 * bundle. Renders nothing until an update is pending, so it's inert in the
 * common case (and entirely inert in dev, where updates are disabled).
 */
export function UpdateBanner() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { isUpdatePending, reload } = useAppUpdates();

  if (!isUpdatePending) return null;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }, elevation.md, { backgroundColor: t.surface2, borderBottomColor: t.border }]}>
      <View style={styles.row}>
        <ArrowUpCircle size={16} color={t.accent} />
        <Text style={[styles.text, { color: t.textPrimary }]} numberOfLines={1}>
          An update is ready.
        </Text>
        <Pressable
          onPress={reload}
          hitSlop={8}
          style={[styles.button, { backgroundColor: t.accent }]}
          accessibilityLabel="Restart to apply update"
        >
          <Text style={[styles.buttonText, { color: t.accentFg }]}>Restart</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  text: { flex: 1, fontSize: 14, fontWeight: "500" },
  button: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 10 },
  buttonText: { fontSize: 13, fontWeight: "700" },
});
