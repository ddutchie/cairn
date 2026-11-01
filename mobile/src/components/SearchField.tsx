import { View, TextInput, Pressable, StyleSheet, type TextInputProps, type StyleProp, type ViewStyle } from "react-native";
import { Search as SearchIcon, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { HintOverlay, useHintCycle } from "@/components/CyclingPlaceholder";

/**
 * Shared inline search field — the roomy variant from the Notes filter bar
 * (icon · input · clear-X, 38pt tall, 10pt radius). Reused by the Knowledge
 * Graph header so its search stops feeling cramped next to Notes.
 *
 * Controlled: pass `value` + `onChangeText`. The clear button appears when
 * there's text and calls `onChangeText("")`. `containerStyle` lets a row layout
 * add `flex: 1`; by default it fills its parent's width (column layouts).
 *
 * `hints` makes the empty field teach by example: the placeholder morphs through them every few
 * seconds, and stops on focus, once there is text, under reduce motion or a screen reader.
 * `placeholder` stays the static fallback and the accessibility label.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder = "Search…",
  hints,
  containerStyle,
  ...rest
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  hints?: readonly string[];
  containerStyle?: StyleProp<ViewStyle>;
} & Pick<TextInputProps, "returnKeyType" | "autoFocus" | "onSubmitEditing">) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [focused, setFocused] = useState(false);
  const cycle = useHintCycle(hints ?? [], !!hints && !value && !focused);
  return (
    <View style={[s.row, containerStyle]}>
      <SearchIcon size={15} color={t.textTertiary} />
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={cycle.visible ? "" : placeholder}
        accessibilityLabel={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholderTextColor={t.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        {...rest}
      />
      {cycle.visible && hints ? <HintOverlay hint={cycle.hint} hints={hints} color={t.textTertiary} fontSize={typeScale.body.fontSize} style={s.hint} /> : null}
      {value ? (
        <Pressable onPress={() => onChangeText("")} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
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
    // Sits over the input's text area: after the icon (15 + gap 8) and the row padding.
    hint: { left: 12 + 15 + 8, right: 12 },
    input: { flex: 1, color: t.textPrimary, ...typeScale.body, padding: 0 },
  });
}
