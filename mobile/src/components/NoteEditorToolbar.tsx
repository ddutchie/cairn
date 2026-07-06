import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, StyleSheet } from "react-native";
import {
  Bold,
  Italic,
  Strikethrough,
  Highlighter,
  Code,
  Link,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  List,
  ListOrdered,
  CheckSquare,
  Code2,
  Minus,
  Link2,
  RefreshCw,
  AlignLeft,
  Expand,
  SpellCheck,
  MessageSquare,
  Wand2,
  X,
} from "lucide-react-native";
import { useTheme, type Theme } from "@/theme";
import { REQUIRES_SELECTION, type FormatAction } from "@cairn/shared/notes/format";
import { AI_ACTIONS, type AITextAction } from "@cairn/shared/notes/ai-actions";

// ── Button definitions ────────────────────────────────────────────────────────

const ICON = 18;

const FORMAT_GROUPS: { id: FormatAction; Icon: typeof Bold }[][] = [
  [
    { id: "bold", Icon: Bold },
    { id: "italic", Icon: Italic },
    { id: "strikethrough", Icon: Strikethrough },
    { id: "highlight", Icon: Highlighter },
    { id: "code", Icon: Code },
    { id: "link", Icon: Link },
  ],
  [
    { id: "h1", Icon: Heading1 },
    { id: "h2", Icon: Heading2 },
    { id: "h3", Icon: Heading3 },
  ],
  [
    { id: "quote", Icon: Quote },
    { id: "bullet", Icon: List },
    { id: "ordered", Icon: ListOrdered },
    { id: "task", Icon: CheckSquare },
  ],
  [
    { id: "codeblock", Icon: Code2 },
    { id: "hr", Icon: Minus },
    { id: "wikilink", Icon: Link2 },
  ],
];

const AI_ICONS: Record<AITextAction, typeof Bold> = {
  rephrase: RefreshCw,
  summarize: AlignLeft,
  expand: Expand,
  fix_grammar: SpellCheck,
  change_tone: MessageSquare,
  custom: Wand2,
};

// ── Component ───────────────────────────────────────────────────────────────

/**
 * The mobile note-editor formatting + AI toolbar — the analogue of the desktop
 * AITextToolbar. Two rows:
 *   1. AI actions (rephrase / summarize / expand / fix grammar / change tone /
 *      custom) — require a selection; "custom" reveals a prompt input.
 *   2. Formatting buttons (bold … wikilink) grouped with dividers.
 * Both rows scroll horizontally to fit narrow phones.
 */
export function NoteEditorToolbar({
  onFormat,
  onAction,
  hasSelection,
  aiEnabled,
  loading,
  onDismiss,
}: {
  onFormat: (action: FormatAction) => void;
  onAction: (action: AITextAction, customPrompt?: string) => void;
  hasSelection: boolean;
  aiEnabled: boolean;
  loading: boolean;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const styles = makeStyles(t);
  const [showCustom, setShowCustom] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (showCustom) inputRef.current?.focus();
  }, [showCustom]);

  function handleAI(action: AITextAction) {
    if (action === "custom") {
      setShowCustom((v) => !v);
      return;
    }
    onAction(action);
  }

  function submitCustom() {
    const p = customPrompt.trim();
    if (!p) return;
    onAction("custom", p);
    setCustomPrompt("");
    setShowCustom(false);
  }

  return (
    <View style={styles.bar}>
      {/* ── AI row ── */}
      {aiEnabled && (
        <View style={styles.aiRow}>
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={t.textTertiary} />
              <Text style={styles.loadingText}>Writing…</Text>
            </View>
          ) : (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowScroll} keyboardShouldPersistTaps="always">
                {AI_ACTIONS.map(({ id, label }) => {
                  const Icon = AI_ICONS[id];
                  const active = id === "custom" && showCustom;
                  return (
                    <Pressable
                      key={id}
                      disabled={!hasSelection}
                      onPress={() => handleAI(id)}
                      style={[styles.aiChip, active && styles.aiChipActive, !hasSelection && styles.disabled]}
                    >
                      <Icon size={13} color={hasSelection ? (active ? t.accent : t.textSecondary) : t.textTertiary} />
                      <Text style={[styles.aiLabel, { color: hasSelection ? (active ? t.accent : t.textSecondary) : t.textTertiary }]}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Pressable onPress={onDismiss} hitSlop={10} style={styles.dismiss}>
                <X size={16} color={t.textTertiary} />
              </Pressable>
            </>
          )}
        </View>
      )}

      {/* Custom prompt input */}
      {aiEnabled && showCustom && !loading && (
        <View style={styles.customRow}>
          <Wand2 size={13} color={t.textTertiary} />
          <TextInput
            ref={inputRef}
            value={customPrompt}
            onChangeText={setCustomPrompt}
            placeholder="Describe what to do with the text…"
            placeholderTextColor={t.textTertiary}
            style={styles.customInput}
            returnKeyType="send"
            onSubmitEditing={submitCustom}
          />
          <Pressable onPress={submitCustom} disabled={!customPrompt.trim()} style={[styles.applyBtn, !customPrompt.trim() && styles.disabled]}>
            <Text style={styles.applyText}>Apply</Text>
          </Pressable>
        </View>
      )}

      {/* ── Formatting row ── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowScroll} keyboardShouldPersistTaps="always">
        {FORMAT_GROUPS.map((group, gi) => (
          <View key={gi} style={styles.group}>
            {gi > 0 && <View style={styles.divider} />}
            {group.map(({ id, Icon }) => {
              const disabled = REQUIRES_SELECTION.has(id) && !hasSelection;
              return (
                <Pressable
                  key={id}
                  disabled={disabled}
                  onPress={() => onFormat(id)}
                  style={[styles.fmtBtn, disabled && styles.disabled]}
                  hitSlop={4}
                >
                  <Icon size={ICON} color={disabled ? t.textTertiary : t.textSecondary} />
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    bar: { backgroundColor: t.surface2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
    aiRow: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border, paddingRight: 8 },
    rowScroll: { alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
    aiChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8 },
    aiChipActive: { backgroundColor: t.surface3 },
    aiLabel: { fontSize: 13, fontWeight: "500" },
    disabled: { opacity: 0.4 },
    dismiss: { padding: 6 },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
    loadingText: { fontSize: 13, color: t.textTertiary },
    customRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border },
    customInput: { flex: 1, color: t.textPrimary, fontSize: 14, padding: 0 },
    applyBtn: { backgroundColor: t.accent, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 6 },
    applyText: { color: t.accentFg, fontSize: 13, fontWeight: "600" },
    group: { flexDirection: "row", alignItems: "center", gap: 4 },
    divider: { width: StyleSheet.hairlineWidth, height: 18, backgroundColor: t.border, marginHorizontal: 6 },
    fmtBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  });
}
