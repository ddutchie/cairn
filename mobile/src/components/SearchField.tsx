import { View, TextInput, Pressable, StyleSheet, type TextInputProps, type StyleProp, type ViewStyle } from "react-native";
import { Search as SearchIcon, X } from "lucide-react-native";
import { useMemo } from "react";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * Shared inline search field — the roomy variant from the Notes filter bar
 * (icon · input · clear-X, 38pt tall, 10pt radius). Reused by the Knowledge
 * Graph header so its search stops feeling cramped next to Notes.
 *
 * Controlled: pass `value` + `onChangeText`. The clear button appears when
 * there's text and calls `onChangeText("")`. `containerStyle` lets a row layout
 * add `flex: 1`; by default it fills its parent's width (column layouts).
 */
export function SearchField({
  value,
  onChangeText,
  placeholder = "Search…",
  containerStyle,
  ...rest
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  containerStyle?: StyleProp<ViewStyle>;
} & Pick<TextInputProps, "returnKeyType" | "autoFocus" | "onSubmitEditing">) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={[s.row, containerStyle]}>
      <SearchIcon size={15} color={t.textTertiary} />
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        {...rest}
      />
      {value ? (
        <Pressable onPress={() => onChangeText("")} hitSlop={8}>
          <X size={15} color={t.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      height: 38,
      backgroundColor: t.surface2,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
    },
    input: { flex: 1, color: t.textPrimary, ...typeScale.body, padding: 0 },
  });
}
