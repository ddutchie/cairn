import { ScrollView, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { useTheme } from "@/theme";
import { useModalOpenHaptic } from "@/haptics";
import { ModalSafeView } from "@/components/ModalSafeView";
import { UsageBody } from "@/components/ai-settings/UsageBody";
import { useEdgePad } from "@/lib/use-edge-pad";

/**
 * Usage — mobile chat token/cost tracker (route wrapper). The body lives in
 * `UsageBody` so it can also render inside the AI-settings Usage tab; this
 * screen only adds the native header + scroll wrapper + modal haptic.
 */
export default function UsageSettingsScreen() {
  const edge = useEdgePad(18);
  useModalOpenHaptic();
  const t = useTheme();
  return (
    <>
      <Stack.Screen options={{ title: "Usage" }} />
      <ModalSafeView backgroundColor={t.surface}>
      <ScrollView
        style={[styles.flex, { backgroundColor: t.surface }]}
        contentContainerStyle={[styles.body, edge]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <UsageBody />
      </ScrollView>
      </ModalSafeView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: 18, gap: 20 },
});
