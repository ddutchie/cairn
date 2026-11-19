import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { User } from "lucide-react-native";
import type { PersonSummary } from "@cairn/shared/types/people-view";
import { GlassBar } from "@/components/GlassBar";
import { KEYBOARD_OPEN_GAP, type, useTheme } from "@/theme";
import { RestingStickyView } from "./RestingStickyView";

const COMPOSER_GAP = 10;

/**
 * People matching the `@name` being typed, as chips above the composer. Sits
 * where the scroll-to-bottom button does and rides the keyboard the same way.
 * Tapping one completes the name; the reply then carries what Cairn knows
 * about them (`mentionContext`).
 */
export function MentionStrip({
  people,
  composerHeight,
  closedLift,
  leftInset = 0,
  onPick,
}: {
  people: readonly PersonSummary[];
  composerHeight: number;
  closedLift: number;
  /** The composer's left offset on a folded screen, so the chips stay in the composer's pane. */
  leftInset?: number;
  onPick: (person: PersonSummary) => void;
}) {
  const t = useTheme();
  if (people.length === 0) return null;
  return (
    <RestingStickyView
      offset={{ closed: -closedLift, opened: -KEYBOARD_OPEN_GAP }}
      style={[styles.root, { bottom: composerHeight + COMPOSER_GAP, left: 14 + leftInset }]}
      pointerEvents="box-none"
    >
      <GlassBar style={styles.bar}>
        <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {people.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => onPick(p)}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${p.name}`}
              style={[styles.chip, { backgroundColor: t.surface3, borderColor: t.border }]}
            >
              <User size={13} color={t.textSecondary} />
              <Text style={[styles.name, { color: t.textPrimary }]} numberOfLines={1}>{p.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </GlassBar>
    </RestingStickyView>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", left: 14, right: 14 },
  bar: { borderRadius: 22, overflow: "hidden", borderCurve: "continuous" },
  row: { padding: 6, gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  name: { ...type.control, maxWidth: 180 },
});
