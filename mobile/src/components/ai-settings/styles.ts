import { StyleSheet } from "react-native";
import { useMemo } from "react";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * The StyleSheet shared by AiSettingsForm and its presentational sub-components
 * (SegmentButton, Field, QuotaBar), moved verbatim from the original monolithic
 * file. The host computes it once (useAiSettingsStyles) and passes it down as a
 * `styles` prop, matching the pre-refactor behaviour exactly.
 */
export function makeAiSettingsStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    loadingBox: { paddingVertical: 48, alignItems: "center" },
    body: { flex: 1 },
    bodyContent: { padding: 18, gap: 8 },

    sectionLabel: {
      ...typeScale.overline,
      color: t.textTertiary,
      marginBottom: 2,
    },
    segment: {
      flexDirection: "row",
      gap: 6,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      padding: 4,
    },
    reasoningBlock: { gap: 8 },
    reasoningHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    segmentBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      paddingVertical: 9,
      borderRadius: 9,
    },
    segmentBtnActive: { backgroundColor: t.accent },
    segmentText: { ...typeScale.control, color: t.textSecondary },
    segmentTextActive: { color: t.accentFg },

    rorkNote: {
      flexDirection: "row",
      gap: 8,
      alignItems: "flex-start",
      backgroundColor: t.surface2,
      borderRadius: 10,
      padding: 12,
      marginTop: 4,
    },
    rorkNoteText: { flex: 1, ...typeScale.caption, color: t.textSecondary, lineHeight: 18 },

    // PCC daily-usage 3-state bar.
    quotaCard: {
      backgroundColor: t.surface2,
      borderRadius: 10,
      padding: 12,
      marginTop: 4,
      gap: 8,
    },
    quotaHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    quotaTitle: { ...typeScale.caption, color: t.textSecondary, fontWeight: "600" },
    quotaStatus: { ...typeScale.caption, fontWeight: "600" },
    quotaTrack: { flexDirection: "row", gap: 3, height: 6 },
    quotaSeg: { flex: 1, height: 6 },
    quotaSegFirst: { borderTopLeftRadius: 3, borderBottomLeftRadius: 3 },
    quotaSegLast: { borderTopRightRadius: 3, borderBottomRightRadius: 3 },
    quotaFootRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    quotaHint: { flex: 1, ...typeScale.caption, color: t.textSecondary },
    quotaUpgrade: { ...typeScale.caption, color: t.accent, fontWeight: "600" },

    fields: { gap: 14, marginTop: 12 },
    field: { gap: 6 },
    fieldLabel: { ...typeScale.label, color: t.textSecondary },
    fieldInput: {
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 11,
      ...typeScale.body,
      color: t.textPrimary,
    },
    keyNote: { flexDirection: "row", gap: 6, alignItems: "flex-start", marginTop: -2 },
    // Instructional/helper copy uses textSecondary (not textTertiary) so it meets
    // WCAG AA contrast on the light surface — tertiary (~2.4:1) failed for text
    // the user is meant to read. Tertiary stays for purely decorative meta.
    keyNoteText: { flex: 1, ...typeScale.caption, color: t.textSecondary, lineHeight: 16 },
    compatHint: { ...typeScale.caption, color: t.textSecondary, lineHeight: 16, marginTop: 2 },

    modelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    fetchBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: t.accentDim,
    },
    fetchBtnText: { ...typeScale.label, color: t.accent },
    modelsError: { ...typeScale.caption, color: t.danger, lineHeight: 16 },
    modelChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
    modelChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: "100%",
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    modelChipActive: { backgroundColor: t.accent, borderColor: t.accent },
    modelChipText: { ...typeScale.caption, color: t.textSecondary, flexShrink: 1 },
    modelChipTextActive: { color: t.accentFg, fontWeight: "600" },

    // Model search + scrollable list (replaces the wrapping chips when the
    // endpoint returns many models).
    modelSearch: {
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      ...typeScale.body,
      color: t.textPrimary,
      marginTop: 2,
    },
    modelListMeta: { ...typeScale.caption, color: t.textTertiary, marginTop: 4 },
    modelList: {
      marginTop: 4,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      backgroundColor: t.surface2,
      maxHeight: 240,
      overflow: "hidden",
    },
    modelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    modelRowActive: { backgroundColor: t.accentDim },
    modelRowText: { ...typeScale.body, color: t.textPrimary, flexShrink: 1 },
    modelRowTextActive: { color: t.accent, fontWeight: "600" },
    modelRowEmpty: { ...typeScale.caption, color: t.textTertiary, paddingHorizontal: 12, paddingVertical: 14 },
    modelRowCost: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    modelRowChip: {
      ...typeScale.caption,
      color: t.textTertiary,
      fontSize: 9,
      lineHeight: 12,
      paddingHorizontal: 2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 3,
      overflow: "hidden",
    },
    modelRowMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: "auto" },

    // Remaining-credits badge (providers that expose a balance, e.g. OpenRouter).
    creditsCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginTop: 2,
    },
    creditsMain: { flex: 1, gap: 2 },
    creditsValue: { ...typeScale.control, color: t.textPrimary, fontWeight: "600" },
    creditsSub: { ...typeScale.caption, color: t.textSecondary },

    // Saved-provider switcher chips.
    providerChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
    providerChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: "100%",
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    providerChipActive: { backgroundColor: t.accent, borderColor: t.accent },
    providerChipText: { ...typeScale.control, color: t.textSecondary, flexShrink: 1 },
    providerChipTextActive: { color: t.accentFg, fontWeight: "600" },
    providerAddChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      borderWidth: 1,
      borderColor: t.accent,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: t.accentDim,
    },
    providerAddText: { ...typeScale.control, color: t.accent },

    navRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      marginTop: 4,
    },
    navRowMain: { flex: 1, gap: 2 },
    navRowTitle: { ...typeScale.control, color: t.textPrimary },
    navRowSub: { ...typeScale.caption, color: t.textSecondary },
  });
}

/** Shared style type passed to every AI-settings sub-component. */
export type AiSettingsStyles = ReturnType<typeof makeAiSettingsStyles>;

/** Hook returning the memoised AI-settings styles for the current theme. */
export function useAiSettingsStyles(): AiSettingsStyles {
  const t = useTheme();
  return useMemo(() => makeAiSettingsStyles(t), [t]);
}
