import { View, Text, TextInput } from "react-native";
import { type Theme } from "@/theme";
import type { AiSettingsStyles } from "./styles";

/** A labelled text input row (base URL, API key, context window, …). */
export function Field({
  label,
  t,
  styles,
  ...input
}: {
  label: string;
  t: Theme;
  styles: AiSettingsStyles;
} & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        placeholderTextColor={t.textTertiary}
        {...input}
      />
    </View>
  );
}
