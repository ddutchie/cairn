import { useMemo } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/PressableScale";
import { haptics } from "@/haptics";
import {
  useTheme,
  useAccent,
  setAccentId,
  useIsDark,
  useFont,
  setFontId,
  resolveRNFontFamily,
  ACCENT_PRESETS,
  FONT_PRESETS,
  type as typeScale,
  type Theme,
} from "@/theme";

/**
 * Appearance settings — accent colour + note-text font. Presented as a modal
 * from the Projects header (right of the Sync button). Light/dark follows the
 * system scheme, so this screen covers the things the user can choose. (The
 * chat theme lives in AI settings → Tuning.)
 */
export default function AppearanceSettingsScreen() {
  const t = useTheme();
  const isDark = useIsDark();
  const accentId = useAccent();
  const fontId = useFont();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.body}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Accent color</Text>
        <Text style={styles.sectionHint}>
          The highlight color used across the app. Each option is tuned for both light and dark
          themes.
        </Text>
        <View style={styles.list}>
          {ACCENT_PRESETS.map((preset) => {
            const variant = isDark ? preset.dark : preset.light;
            const active = preset.id === accentId;
            return (
              <PressableScale
                key={preset.id}
                style={[styles.row, active && styles.rowActive]}
                onPress={() => {
                  haptics.selection();
                  setAccentId(preset.id);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={preset.name}
              >
                <View style={[styles.swatch, { backgroundColor: variant.accent, borderColor: t.border }]} />
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{preset.name}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {preset.description}
                  </Text>
                </View>
                {active && <Check size={18} color={t.accent} />}
              </PressableScale>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Note font</Text>
        <Text style={styles.sectionHint}>
          Font used for note text — the editor, preview, and PDF export. UI stays on the system
          font.
        </Text>
        <View style={styles.list}>
          {FONT_PRESETS.map((preset) => {
            const active = preset.id === fontId;
            return (
              <PressableScale
                key={preset.id}
                style={[styles.row, active && styles.rowActive]}
                onPress={() => {
                  haptics.selection();
                  setFontId(preset.id);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={preset.name}
              >
                <Text style={[styles.fontSample, { fontFamily: resolveRNFontFamily(preset.id), color: t.textPrimary }]}>
                  Aa
                </Text>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>{preset.name}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {preset.description}
                  </Text>
                </View>
                {active && <Check size={18} color={t.accent} />}
              </PressableScale>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    body: { padding: 18, gap: 20 },
    section: { gap: 8 },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary },
    sectionHint: { ...typeScale.caption, color: t.textTertiary, marginBottom: 4 },
    list: { gap: 8 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    rowActive: { borderColor: t.accent, backgroundColor: t.accentDim },
    swatch: { width: 26, height: 26, borderRadius: 999, borderWidth: 1 },
    fontSample: { ...typeScale.title, minWidth: 32, textAlign: "center" },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...typeScale.control, color: t.textPrimary },
    rowSub: { ...typeScale.caption, color: t.textSecondary },
  });
}
