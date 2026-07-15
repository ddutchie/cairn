import { useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { CheckCircle, ChevronRight } from "lucide-react-native";
import { useRouter } from "expo-router";
import { prettifyToolLabel } from "@cairn/shared/ui/constants";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { haptics } from "@/haptics";
import type { ToolCall } from "@/db/chat-store";

/**
 * The vertical trail of tool-call chips shown above an assistant bubble. A chip
 * whose tool created/touched a note or card is tappable and opens it by id (the
 * reliable, collision-proof path); read-only tools render as a plain chip.
 */
export function ToolTrail({ tools }: { tools: ToolCall[] }) {
  const t = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.toolTrail}>
      {tools.map((tt, i) => {
        const label = prettifyToolLabel(tt.tool, { prettifyBare: true });
        if (tt.ref) {
          return (
            <Pressable
              key={i}
              style={styles.toolChip}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Open ${label}`}
              onPress={() => {
                haptics.impact();
                router.push(tt.ref!.kind === "card" ? `/card/${tt.ref!.id}` : `/note/${tt.ref!.id}`);
              }}
            >
              <CheckCircle size={10} color={tt.ok ? t.accent : t.danger} />
              <Text style={[styles.toolChipText, styles.toolChipLink]}>{label}</Text>
              <ChevronRight size={10} color={t.accent} />
            </Pressable>
          );
        }
        return (
          <View key={i} style={styles.toolChip}>
            <CheckCircle size={10} color={tt.ok ? t.accent : t.danger} />
            <Text style={styles.toolChipText}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    toolTrail: { flexDirection: "column", gap: 4, alignSelf: "flex-start" },
    toolChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    toolChipText: { ...typeScale.caption, color: t.textSecondary },
    toolChipLink: { color: t.accent },
  });
}
