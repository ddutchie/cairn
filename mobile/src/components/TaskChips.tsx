import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme, PRIORITY_COLOR, PRIORITIES, type as typeScale } from "@/theme";
import type { ColumnRow } from "@/db/queries";

/** Shared chip geometry — a pill with a 1px border, used by both chip rows. */
const chipStyles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
  text: { ...typeScale.label },
});

/**
 * Priority selector — the low/medium/high/urgent pill row shared by the
 * new-task composer and the card detail screen. Each chip is outlined in its
 * priority colour and fills with it when selected.
 */
export function PriorityChips({
  value,
  onChange,
}: {
  value: string;
  onChange: (priority: string) => void;
}) {
  const t = useTheme();
  return (
    <View style={chipStyles.row}>
      {PRIORITIES.map((p) => (
        <Pressable
          key={p}
          onPress={() => onChange(p)}
          style={[chipStyles.chip, { borderColor: PRIORITY_COLOR[p] }, value === p && { backgroundColor: PRIORITY_COLOR[p] }]}
        >
          <Text style={[chipStyles.text, { textTransform: "capitalize", color: value === p ? t.accentFg : t.textSecondary }]}>
            {p}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Column selector — the board-column pill row shared by the new-task composer
 * and the card detail screen. Each chip fills with the accent colour when
 * selected.
 */
export function ColumnChips({
  columns,
  value,
  onChange,
}: {
  columns: ColumnRow[];
  value: string;
  onChange: (columnId: string) => void;
}) {
  const t = useTheme();
  return (
    <View style={chipStyles.row}>
      {columns.map((c) => (
        <Pressable
          key={c.id}
          onPress={() => onChange(c.id)}
          style={[chipStyles.chip, { borderColor: t.border }, value === c.id && { backgroundColor: t.accent, borderColor: t.accent }]}
        >
          <Text style={[chipStyles.text, { color: value === c.id ? t.accentFg : t.textSecondary }]}>{c.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}
