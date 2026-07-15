import { Pressable, Text } from "react-native";
import { type as typeScale, type Theme } from "@/theme";

/** One tab in the Overview / Notes / Board segmented control. */
export function Segment({
  label,
  count,
  active,
  onPress,
  t,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
  t: Theme;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" }, active && { backgroundColor: t.surface }]}
    >
      <Text style={{ color: active ? t.textPrimary : t.textTertiary, fontWeight: active ? "600" : "400", fontSize: typeScale.label.fontSize }}>
        {label}
        {count !== undefined ? <Text style={{ color: t.textTertiary }}> {count}</Text> : null}
      </Text>
    </Pressable>
  );
}
