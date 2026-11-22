import { ScrollView, StyleSheet } from "react-native";
import { TabScreen } from "@/components/TabScreen";
import { UsageBody } from "@/components/ai-settings/UsageBody";
import { useEdgePad } from "@/lib/use-edge-pad";

/**
 * Usage — mobile chat token/cost tracker. A Workspace tool (pushed inside the tab,
 * so the tab bar stays); the body lives in `UsageBody`. The title comes from the
 * Workspace stack's screen options.
 */
export default function UsageScreen() {
  const edge = useEdgePad(18);
  return (
    <TabScreen>
      <ScrollView style={styles.flex} contentContainerStyle={[styles.body, edge]} contentInsetAdjustmentBehavior="automatic">
        <UsageBody />
      </ScrollView>
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: 18, gap: 20 },
});
