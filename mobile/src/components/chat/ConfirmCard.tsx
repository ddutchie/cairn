import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { cancelConfirm, confirmPending, type PendingConfirm } from "@/chat/confirm-store";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * The Delete / Cancel card at the end of the transcript. The `delete` tool waits
 * on it, so nothing is deleted until the user taps the destructive button.
 */
export function ConfirmCard({ pending }: { pending: PendingConfirm }) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);

  const confirm = () => {
    haptics.warning();
    confirmPending();
  };
  const cancel = () => {
    haptics.selection();
    cancelConfirm();
  };

  return (
    <View style={s.card} accessibilityLabel="Confirm before the assistant goes on">
      <Text style={s.title}>{pending.title}</Text>
      {pending.detail ? <Text style={s.detail}>{pending.detail}</Text> : null}
      <View style={s.actions}>
        <Pressable onPress={cancel} hitSlop={8} accessibilityRole="button" style={s.cancel}>
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable onPress={confirm} accessibilityRole="button" style={s.confirm}>
          <Text style={s.confirmText}>{pending.confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    card: { marginVertical: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, gap: 8 },
    title: { ...typeScale.subtitle, color: t.textPrimary },
    detail: { ...typeScale.caption, color: t.textSecondary },
    actions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 16, marginTop: 4 },
    cancel: { paddingVertical: 8 },
    cancelText: { ...typeScale.label, color: t.textSecondary },
    confirm: { backgroundColor: t.danger, borderRadius: 12, paddingVertical: 9, paddingHorizontal: 16 },
    confirmText: { ...typeScale.label, color: t.dangerFg },
  });
}
