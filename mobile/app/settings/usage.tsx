import { ScrollView, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { useTheme } from "@/theme";
import { useModalOpenHaptic } from "@/haptics";
import { UsageBody } from "@/components/ai-settings/UsageBody";

/**
 * Usage — mobile chat token/cost tracker (route wrapper). The body lives in
 * `UsageBody` so it can also render inside the AI-settings Usage tab; this
 * screen only adds the native header + scroll wrapper + modal haptic.
 */
export default function UsageSettingsScreen() {
  useModalOpenHaptic();
  const t = useTheme();
  return (
    <>
      <Stack.Screen options={{ title: "Usage" }} />
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.body, { backgroundColor: t.surface }]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <UsageBody />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: 18, gap: 20 },
});
