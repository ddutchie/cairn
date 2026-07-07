import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import Animated, { useAnimatedStyle, interpolate } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { ChevronLeft, ChevronRight ,
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
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { REQUIRES_SELECTION, type FormatAction } from "@cairn/shared/notes/format";
import { AI_ACTIONS, type AITextAction } from "@cairn/shared/notes/ai-actions";

// ── Button definitions ────────────────────────────────────────────────────────

const ICON = 18;

/** Human-readable accessibility labels for the icon-only formatting buttons. */
const FORMAT_LABELS: Record<FormatAction, string> = {
  bold: "Bold",
  italic: "Italic",
  strikethrough: "Strikethrough",
  code: "Inline code",
  highlight: "Highlight",
  link: "Link",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  quote: "Quote",
  bullet: "Bulleted list",
  ordered: "Numbered list",
  task: "Task list",
  codeblock: "Code block",
  hr: "Horizontal rule",
  wikilink: "Link a note",
};

function formatActionLabel(id: FormatAction): string {
  return FORMAT_LABELS[id] ?? id;
}

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
 * A horizontally-scrolling row that shows a chevron cue at whichever edge has
 * more content off-screen, so it's obvious the row scrolls. The cue is a small
 * pill tinted with the bar background (a cheap edge-fade — no LinearGradient
 * dependency) with a chevron on top. It hides once you reach that end.
 */
function ScrollAffordanceRow({ children, fill }: { children: React.ReactNode; fill?: boolean }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = (contentW: number, layoutW: number, x: number) => {
    setCanLeft(x > 1);
    setCanRight(x < contentW - layoutW - 1);
  };
  const layoutW = useRef(0);
  const contentW = useRef(0);
  const offX = useRef(0);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offX.current = e.nativeEvent.contentOffset.x;
    update(contentW.current, layoutW.current, offX.current);
  };
  const onLayout = (e: LayoutChangeEvent) => {
    layoutW.current = e.nativeEvent.layout.width;
    update(contentW.current, layoutW.current, offX.current);
  };
  const onContentSize = (w: number) => {
    contentW.current = w;
    update(contentW.current, layoutW.current, offX.current);
  };

  return (
    <View style={[styles.affordanceWrap, fill && styles.affordanceFill]} onLayout={onLayout}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowScroll}
        keyboardShouldPersistTaps="always"
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSize}
      >
        {children}
      </ScrollView>
      {canLeft && (
        <View style={[styles.edgeCue, styles.edgeLeft]} pointerEvents="none">
          <View style={[styles.fadeBand, { backgroundColor: withAlpha(t.surface2, 1), left: 0 }]} />
          <View style={[styles.fadeBand, { backgroundColor: withAlpha(t.surface2, 0.6), left: 8 }]} />
          <View style={[styles.fadeBand, { backgroundColor: withAlpha(t.surface2, 0.25), left: 16 }]} />
          <ChevronLeft size={16} color={t.textSecondary} />
        </View>
      )}
      {canRight && (
        <View style={[styles.edgeCue, styles.edgeRight]} pointerEvents="none">
          <View style={[styles.fadeBand, { backgroundColor: withAlpha(t.surface2, 1), right: 0 }]} />
          <View style={[styles.fadeBand, { backgroundColor: withAlpha(t.surface2, 0.6), right: 8 }]} />
          <View style={[styles.fadeBand, { backgroundColor: withAlpha(t.surface2, 0.25), right: 16 }]} />
          <ChevronRight size={16} color={t.textSecondary} />
        </View>
      )}
    </View>
  );
}

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
  bottomInset = 0,
}: {
  onFormat: (action: FormatAction) => void;
  onAction: (action: AITextAction, customPrompt?: string) => void;
  hasSelection: boolean;
  aiEnabled: boolean;
  loading: boolean;
  onDismiss: () => void;
  /** Home-indicator inset, applied only while the keyboard is closed. */
  bottomInset?: number;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [showCustom, setShowCustom] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const inputRef = useRef<TextInput>(null);

  // The toolbar rides the keyboard via KeyboardStickyView, so when the keyboard
  // is up it sits flush against it (no inset). When closed it drops to the
  // screen bottom and must clear the home indicator — animate the extra bottom
  // padding from `bottomInset` (closed) to 0 (open).
  const { progress } = useReanimatedKeyboardAnimation();
  const insetStyle = useAnimatedStyle(() => ({
    paddingBottom: interpolate(progress.value, [0, 1], [bottomInset, 0]),
  }));

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

  // Reset the custom-AI input on dismiss so it doesn't reappear (with stale
  // text) the next time the toolbar/keyboard is focused.
  function handleDismiss() {
    setShowCustom(false);
    setCustomPrompt("");
    onDismiss();
  }

  return (
    <Animated.View style={[styles.bar, insetStyle]}>
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
              <ScrollAffordanceRow fill>
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
              </ScrollAffordanceRow>
              <Pressable onPress={handleDismiss} hitSlop={10} style={styles.dismiss}>
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
      <ScrollAffordanceRow>
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
                  accessibilityRole="button"
                  accessibilityLabel={formatActionLabel(id)}
                  accessibilityState={{ disabled }}
                >
                  <Icon size={ICON} color={disabled ? t.textTertiary : t.textSecondary} />
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollAffordanceRow>
    </Animated.View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    bar: { backgroundColor: t.surface2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
    aiRow: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border, paddingRight: 8 },
    rowScroll: { alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
    affordanceWrap: { position: "relative" },
    affordanceFill: { flex: 1 },
    edgeCue: {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: 30,
      alignItems: "center",
      justifyContent: "center",
    },
    edgeLeft: { left: 0, alignItems: "flex-start", paddingLeft: 2 },
    edgeRight: { right: 0, alignItems: "flex-end", paddingRight: 2 },
    fadeBand: { position: "absolute", top: 0, bottom: 0, width: 14 },
    aiChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8 },
    aiChipActive: { backgroundColor: t.surface3 },
    aiLabel: { ...typeScale.caption, fontWeight: "500" },
    disabled: { opacity: 0.4 },
    dismiss: { padding: 6 },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
    loadingText: { ...typeScale.caption, color: t.textTertiary },
    customRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border },
    customInput: { flex: 1, color: t.textPrimary, ...typeScale.caption, padding: 0 },
    applyBtn: { backgroundColor: t.accent, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 6 },
    applyText: { ...typeScale.label, color: t.accentFg },
    group: { flexDirection: "row", alignItems: "center", gap: 4 },
    divider: { width: StyleSheet.hairlineWidth, height: 18, backgroundColor: t.border, marginHorizontal: 6 },
    fmtBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  });
}
