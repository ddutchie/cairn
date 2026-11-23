import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { answerQuestions, getAnswerDraft, setAnswerDraft, skipQuestions, type PendingQuestions } from "@/chat/questions-store";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * The assistant's `ask_questions` form, at the end of the transcript: one answer
 * box per question, sent together. The reply goes back to the same turn as the
 * tool's result, so the assistant carries on with the answers.
 */
export function QuestionCard({ pending, onFocusAnswer }: { pending: PendingQuestions; onFocusAnswer?: () => void }) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  // Seeded from the store: this card remounts when the app resumes, and what was typed must stay.
  const [answers, setAnswers] = useState<Record<string, string>>(() => getAnswerDraft(pending.id));
  const anyAnswer = Object.values(answers).some((a) => a.trim().length > 0);

  const send = () => {
    if (!anyAnswer) return;
    haptics.success();
    answerQuestions(answers);
  };
  const skip = () => {
    haptics.selection();
    skipQuestions();
  };

  return (
    <View style={s.card} accessibilityLabel="Questions from the assistant">
      <Text style={s.heading}>{pending.questions.length === 1 ? "A question before I go on" : "A few questions before I go on"}</Text>
      {pending.questions.map((q, i) => (
        <View key={q.id} style={s.question}>
          <Text style={s.label}>{q.label}</Text>
          {q.prompt ? <Text style={s.prompt}>{q.prompt}</Text> : null}
          <TextInput
            style={s.input}
            value={answers[q.id] ?? ""}
            onChangeText={(v) => setAnswers((cur) => { const next = { ...cur, [q.id]: v }; setAnswerDraft(pending.id, next); return next; })}
            placeholder="Your answer"
            placeholderTextColor={t.textTertiary}
            multiline
            autoFocus={i === 0}
            onFocus={onFocusAnswer}
            accessibilityLabel={q.label}
            accessibilityHint={q.prompt || undefined}
          />
        </View>
      ))}
      <View style={s.actions}>
        <Pressable onPress={skip} hitSlop={8} accessibilityRole="button" style={s.skip}>
          <Text style={s.skipText}>Skip</Text>
        </Pressable>
        <Pressable
          onPress={send}
          disabled={!anyAnswer}
          accessibilityRole="button"
          accessibilityState={{ disabled: !anyAnswer }}
          style={[s.send, { opacity: anyAnswer ? 1 : 0.4 }]}
        >
          <Text style={s.sendText}>Send answers</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    card: { marginVertical: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, gap: 12 },
    heading: { ...typeScale.subtitle, color: t.textPrimary },
    question: { gap: 4 },
    label: { ...typeScale.label, color: t.textPrimary },
    prompt: { ...typeScale.caption, color: t.textSecondary },
    input: { ...typeScale.body, color: t.textPrimary, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, marginTop: 4 },
    actions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 16 },
    skip: { paddingVertical: 8 },
    skipText: { ...typeScale.label, color: t.textSecondary },
    send: { backgroundColor: t.accent, borderRadius: 12, paddingVertical: 9, paddingHorizontal: 16 },
    sendText: { ...typeScale.label, color: t.accentFg },
  });
}
