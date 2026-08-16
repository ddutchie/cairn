import { useMemo } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * PresetStepperRow — a row of selectable preset chips (mirrors the desktop
 * StepperSettingsRow's bordered chip buttons + optional Auto). Used for the
 * Model tab's temperature / max steps knobs.
 *
 *  - `value` the current value (number)
 *  - `onChange(v)` persist a preset
 *  - `presets` the chip values to offer
 *  - `formatPreset(n)` display formatting (e.g. "∞" for 1000)
 *  - `autoActive` when true, the Auto chip renders highlighted and no preset is
 *    shown active (temperature "Auto" = omit the field)
 *  - `onAuto` when provided, renders the Auto chip
 */
export function PresetStepperRow({
  label,
  description,
  value,
  onChange,
  presets,
  formatPreset = (n) => String(n),
  autoActive = false,
  onAuto,
}: {
  label: string;
  description?: string;
  value: number;
  onChange: (v: number) => void;
  presets: readonly number[];
  formatPreset?: (n: number) => string;
  autoActive?: boolean;
  onAuto?: () => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.label}>{label}</Text>
        {description ? <Text style={styles.desc}>{description}</Text> : null}
      </View>
      <View style={styles.chips}>
        {onAuto && (
          <Pressable
            style={[styles.chip, autoActive && styles.chipActive]}
            onPress={onAuto}
            accessibilityRole="button"
            accessibilityState={{ selected: autoActive }}
          >
            <Text style={[styles.chipText, autoActive && styles.chipTextActive]}>Auto</Text>
          </Pressable>
        )}
        {presets.map((n) => {
          const active = !autoActive && value === n;
          return (
            <Pressable
              key={n}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onChange(n)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{formatPreset(n)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    row: { gap: 8 },
    head: { gap: 2 },
    label: { ...typeScale.label, color: t.textSecondary },
    desc: { ...typeScale.caption, color: t.textSecondary, lineHeight: 16 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 8,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
    },
    chipActive: { backgroundColor: t.accent, borderColor: t.accent },
    chipText: { ...typeScale.caption, color: t.textTertiary },
    chipTextActive: { color: t.accentFg, fontWeight: "600" },
  });
}
