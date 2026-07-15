import { View, Text, Pressable } from "react-native";
import { type Theme } from "@/theme";
import { type AppleQuotaStatus } from "@modules/apple-llm";
import type { AiSettingsStyles } from "./styles";

/**
 * Private Cloud Compute daily-usage indicator. Apple exposes no exact numbers,
 * only a 3-state status (below / approaching / reached) + a reset date, so we
 * render a 3-segment bar that fills to the current state (green → amber → red)
 * rather than a precise gauge — matching Apple's "communicate the current
 * status" guidance. Shows a reset date and an iCloud+ upgrade action.
 */
export function QuotaBar({
  quota,
  onUpgrade,
  t,
  styles,
}: {
  quota: AppleQuotaStatus;
  onUpgrade: () => void;
  t: Theme;
  styles: AiSettingsStyles;
}) {
  // How many of the 3 segments are lit, and the fill colour, per state.
  const level = quota.isLimitReached ? 3 : quota.status === "approaching" ? 2 : 1;
  const colour = quota.isLimitReached ? t.danger : quota.status === "approaching" ? t.warning : t.success;
  const label = quota.isLimitReached
    ? "Daily limit reached"
    : quota.status === "approaching"
      ? "Approaching daily limit"
      : "Within daily limit";
  const reset =
    quota.resetDate && quota.status !== "below"
      ? `Resets ${new Date(quota.resetDate).toLocaleDateString()}`
      : "";

  return (
    <View style={styles.quotaCard}>
      <View style={styles.quotaHeaderRow}>
        <Text style={styles.quotaTitle}>Private Cloud Compute</Text>
        <Text style={[styles.quotaStatus, { color: colour }]}>{label}</Text>
      </View>
      <View
        style={styles.quotaTrack}
        accessibilityRole="progressbar"
        accessibilityLabel={`Private Cloud Compute usage: ${label}`}
      >
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={[
              styles.quotaSeg,
              { backgroundColor: i < level ? colour : t.border },
              i === 0 && styles.quotaSegFirst,
              i === 2 && styles.quotaSegLast,
            ]}
          />
        ))}
      </View>
      <View style={styles.quotaFootRow}>
        <Text style={styles.quotaHint}>
          {reset || "Usage resets daily. No API key needed."}
        </Text>
        {quota.canUpgrade && (
          <Pressable onPress={onUpgrade} hitSlop={8}>
            <Text style={styles.quotaUpgrade}>Get more with iCloud+</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
