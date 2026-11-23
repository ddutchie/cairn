import { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/PressableScale";
import { SearchField } from "@/components/SearchField";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/** A choice in a picker list. */
export interface PickerOption {
  value: string;
  label: string;
  note?: string;
}

/** A searchable list of choices, the body of a picker page inside a `ModalForm` (`scroll={false}`). */
export function PickerList({ options, selected, onPick, empty }: {
  options: PickerOption[]; selected?: string; onPick: (value: string) => void; empty?: string;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.note?.toLowerCase().includes(q)) : options;
  return (
    <>
      <View style={s.search}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search" />
      </View>
      <FlatList
        data={shown}
        style={s.list}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(o) => o.value || "_none"}
        ListEmptyComponent={<Text style={s.empty}>{empty ?? "Nothing to pick."}</Text>}
        renderItem={({ item }) => (
          <PressableScale style={s.row} onPress={() => onPick(item.value)} accessibilityLabel={item.label}>
            <View style={s.flex}>
              <Text style={s.line} numberOfLines={1}>{item.label}</Text>
              {item.note ? <Text style={s.note} numberOfLines={1}>{item.note}</Text> : null}
            </View>
            {selected === item.value ? <Check size={16} color={t.accent} /> : null}
          </PressableScale>
        )}
      />
    </>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    search: { paddingHorizontal: 14, paddingTop: 10 },
    list: { flex: 1 },
    row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 18 },
    line: { ...typeScale.body, color: t.textPrimary },
    note: { ...typeScale.caption, color: t.textTertiary },
    empty: { ...typeScale.body, color: t.textTertiary, padding: 18 },
  });
}
