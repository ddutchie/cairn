import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Brain, ChevronRight } from "lucide-react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * Collapsible "reasoning" (thinking) disclosure for models that stream it
 * (Apple PCC, or OpenAI-compatible endpoints like DeepSeek/OpenRouter).
 * Expanded while the model is still thinking, auto-collapses the instant the
 * answer starts streaming (mirrors desktop), and stays collapsed once done.
 * Session-only (not persisted).
 */
export function ReasoningBlock({ text, summary, streaming, hasContent }: { text: string; summary?: string; streaming?: boolean; hasContent?: boolean }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  // `open` is the user's manual override: true = force expanded, false = force
  // collapsed, null = auto (follow the stream). Using an explicit override (not
  // just `open || ...`) lets the user COLLAPSE while the model is still thinking
  // — a plain `open || (streaming && !hasContent)` can never be turned off until
  // the answer starts, so the panel would stay stuck open.
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override !== null ? override : !!streaming && !hasContent;
  const collapsedText = summary && summary.trim() ? summary.trim() : null;
  return (
    <View style={styles.reasoning}>
      <Pressable
        style={styles.reasoningHeader}
        onPress={() => setOverride((v) => (v === null ? !expanded : !v))}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Hide reasoning" : "Show reasoning"}
        accessibilityState={{ expanded }}
      >
        <Brain size={11} color={t.textTertiary} />
        <Text style={styles.reasoningLabel}>{streaming && !hasContent ? "Thinking…" : "Reasoning"}</Text>
        <ChevronRight
          size={12}
          color={t.textTertiary}
          style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}
        />
      </Pressable>
      {expanded ? (
        // Prefer the raw trace; fall back to the summary so summary-only
        // reasoning stays visible when expanded.
        text ? <Text style={styles.reasoningText}>{text}</Text> : collapsedText ? <Text style={styles.reasoningText}>{collapsedText}</Text> : null
      ) : collapsedText ? (
        <Text style={styles.reasoningSummary} numberOfLines={2}>{collapsedText}</Text>
      ) : null}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    reasoning: {
      alignSelf: "flex-start",
      maxWidth: "94%",
      gap: 4,
      marginBottom: 2,
      paddingLeft: 2,
    },
    reasoningHeader: { flexDirection: "row", alignItems: "center", gap: 5 },
    reasoningLabel: {
      ...typeScale.overline,
      color: t.textTertiary,
    },
    reasoningText: {
      ...typeScale.caption,
      color: t.textTertiary,
      fontStyle: "italic",
      lineHeight: 17,
      paddingLeft: 16,
    },
    reasoningSummary: {
      ...typeScale.caption,
      color: t.textTertiary,
      lineHeight: 17,
      paddingLeft: 16,
    },
  });
}
