import { View, Text } from "react-native";
import { type as typeScale, type Theme } from "@/theme";

/** Centered placeholder shown when a filtered notes list has no matches. */
export function Empty({ text, t }: { text: string; t: Theme }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ ...typeScale.caption, color: t.textTertiary, textAlign: "center" }}>{text}</Text>
    </View>
  );
}
