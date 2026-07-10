import { Text, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import { useTheme, type as typeScale } from "@/theme";

/**
 * An uppercase, tracked section/card header label — the small `textTertiary`
 * caption that sits above a card or form group (e.g. "iCloud sync folder",
 * "Workspace", "Related notes"). Consolidates the ad-hoc
 * `{ fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:0.5 }`
 * style objects that had drifted across screens (11–12px, 600/700, 0.4/0.5) into
 * the shared `type.overline` token, so they scale with the OS text-size setting.
 *
 * Pass `style` for per-site spacing (e.g. `marginTop`/`marginBottom`).
 */
export function SectionLabel({
  children,
  style,
}: {
  children: string;
  style?: StyleProp<TextStyle>;
}) {
  const t = useTheme();
  return <Text style={[styles.label, { color: t.textTertiary }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  label: { ...typeScale.overline },
});
