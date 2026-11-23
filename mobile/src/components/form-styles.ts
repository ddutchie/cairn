import { StyleSheet } from "react-native";
import { type as typeScale, type Theme } from "@/theme";

/** The styles the People form modals share: labelled fields, chips, a pick row. */
export function makeFormStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    gap: { marginTop: 16 },
    label: { ...typeScale.overline, color: t.textTertiary },
    input: {
      ...typeScale.body, color: t.textPrimary, marginTop: 6, paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
    chip: {
      flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 5, paddingHorizontal: 11, borderRadius: 14,
      backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, justifyContent: "center",
    },
    chipOn: { borderColor: t.accent, backgroundColor: t.accentDim },
    chipText: { ...typeScale.caption, color: t.textSecondary, fontWeight: "600" },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 8 },
    pick: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, paddingVertical: 12, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    line: { ...typeScale.body, color: t.textPrimary },
    empty: { ...typeScale.body, color: t.textTertiary },
    chevron: { ...typeScale.title, fontWeight: "400", color: t.textTertiary },
  });
}
