import { forwardRef, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, type TextInput as TextInputType } from "react-native";
import { Image } from "expo-image";
import { Send, X, Plus } from "lucide-react-native";
import Animated, { Extrapolation, FadeOut, interpolate, LinearTransition, useAnimatedReaction, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useTheme, withAlpha, type Theme } from "@/theme";
import { Glass } from "./attachment-panel/glass";
import { COLORS, COMPOSER, COMPOSER_STRIP_HEIGHT, DURATION, GUTTER } from "./attachment-panel/constants";
import type { Attachment } from "@/chat/agent";

function Thumbnail({ url, hidden, onRemove }: { url: string; hidden: boolean; onRemove: () => void }) {
  // expo-image handles ph://, file://, content:// and data: URIs — pass as object for data URIs to ensure correct parsing
  const source = { uri: url } as const;
  return (
    <Animated.View exiting={FadeOut.duration(DURATION.crossfade)} layout={LinearTransition.duration(DURATION.attach)} style={[styles.thumb, hidden && styles.thumbHidden]}>
      <Image source={source} contentFit="cover" cachePolicy="memory-disk" style={StyleSheet.absoluteFill} />
      <Pressable accessibilityRole="button" hitSlop={10} onPress={onRemove} style={styles.remove}>
        <X size={11} color="#fff" />
      </Pressable>
    </Animated.View>
  );
}

export interface CairnMorphComposerProps {
  input: string;
  onChangeInput: (v: string) => void;
  attachments: Attachment[];
  pendingIds: string[];
  strip: SharedValue<number>;
  plusOut: SharedValue<number>;
  onPlusPress: () => void;
  onRemove: (idx: number) => void;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  onInputFocus: () => void;
  closedLift: number;
  onLayoutHeight: (h: number) => void;
  allowImages?: boolean;
  queuedCount?: number;
}

export const CairnMorphComposer = forwardRef<TextInputType, CairnMorphComposerProps>(function CairnMorphComposer(
  { input, onChangeInput, attachments, pendingIds, strip, plusOut, onPlusPress, onRemove, busy, canSend, onSend, onInputFocus, closedLift, onLayoutHeight, allowImages = true, queuedCount = 0 },
  ref,
) {
  const t = useTheme();
  const hasAttachments = attachments.length > 0;

  const plusStyle = useAnimatedStyle(() => ({
    opacity: interpolate(plusOut.get(), [0, 0.75], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateX: plusOut.get() * COMPOSER.plusSlide }],
  }));

  const [retained, setRetained] = useState(attachments);
  useEffect(() => {
    if (hasAttachments) setRetained(attachments);
  }, [attachments, hasAttachments]);

  useAnimatedReaction(
    () => strip.get() === 0,
    (shut, wasShut) => {
      if (shut && wasShut === false) scheduleOnRN(setRetained, [] as Attachment[]);
    },
  );

  const stripStyle = useAnimatedStyle(() => ({ height: strip.get() * COMPOSER_STRIP_HEIGHT }));
  const KEYBOARD_OPEN_GAP = 8;

  // Theme-aware glass fallback — solid when liquid glass unavailable
  const fallbackBg = withAlpha(t.surface2, 0.92);
  const isLight = t.background === "#f5f4f1" || t.textPrimary === "#1a1917";
  return (
    <KeyboardStickyView offset={{ closed: -closedLift, opened: -KEYBOARD_OPEN_GAP }} style={styles.composerOverlay}>
      <View onLayout={(e) => onLayoutHeight(e.nativeEvent.layout.height)}>
        <View style={[styles.composerWrap]}>
          <Glass radius={COMPOSER.radius} interactive={false} fallbackTint={fallbackBg} style={styles.glassRoot}>
            <Animated.View style={[styles.strip, stripStyle]}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none" style={styles.stripScroll} contentContainerStyle={styles.stripContent}>
                {retained.map((a, i) => (
                  <Thumbnail key={`${a.url}-${i}`} url={a.url} hidden={pendingIds.includes(a.url)} onRemove={() => onRemove(i)} />
                ))}
              </ScrollView>
            </Animated.View>
            <View style={styles.row}>
              <Pressable accessibilityRole="button" hitSlop={12} onPress={onPlusPress} style={styles.plus} disabled={busy && !allowImages}>
                <Animated.View style={plusStyle}>
                  <Plus size={COMPOSER.plusSize} color={busy || !allowImages ? withAlpha(t.textTertiary, 0.5) : isLight ? t.textSecondary : t.textTertiary} />
                </Animated.View>
              </Pressable>
              <TextInput
                ref={ref}
                value={input}
                onChangeText={onChangeInput}
                onFocus={onInputFocus}
                placeholder="Message Cairn…"
                placeholderTextColor={isLight ? t.textSecondary : t.textTertiary}
                multiline
                textAlignVertical="center"
                style={[styles.field, { color: t.textPrimary }]}
              />
              <Pressable
                style={[styles.sendBtn, { backgroundColor: t.accent }, !canSend && styles.sendBtnDisabled]}
                onPress={onSend}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel={busy ? "Queue message" : "Send message"}
              >
                <View>
                  <Send size={14} color={t.accentFg} />
                  {busy && queuedCount > 0 ? <Animated.Text style={styles.sendBadge}>{String(queuedCount)}</Animated.Text> : null}
                </View>
              </Pressable>
            </View>
          </Glass>
        </View>
      </View>
    </KeyboardStickyView>
  );
});

const styles = StyleSheet.create({
  composerOverlay: { position: "absolute", left: 0, right: 0, bottom: 0 },
  composerWrap: { paddingHorizontal: GUTTER, paddingTop: 8 },
  glassRoot: { overflow: "hidden", borderCurve: "continuous" as const },
  strip: { overflow: "hidden", borderTopLeftRadius: COMPOSER.radius - COMPOSER.stripPaddingTop, borderTopRightRadius: COMPOSER.radius - COMPOSER.stripPaddingTop, borderCurve: "continuous" as const },
  stripScroll: { position: "absolute", left: 0, right: 0, top: COMPOSER.stripPaddingTop, height: COMPOSER.thumbSize },
  stripContent: { paddingLeft: COMPOSER.stripPaddingTop, gap: COMPOSER.thumbGap },
  thumb: { width: COMPOSER.thumbSize, height: COMPOSER.thumbSize, borderRadius: COMPOSER.thumbRadius, overflow: "hidden", backgroundColor: "#141414", borderCurve: "continuous" as const },
  thumbHidden: { opacity: 0 },
  row: { minHeight: COMPOSER.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: COMPOSER.rowPaddingLeft, paddingRight: 9, paddingVertical: 6, gap: 10 },
  plus: { width: COMPOSER.plusHit, height: 32, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  field: { flex: 1, fontSize: COMPOSER.fieldSize, paddingVertical: 0, paddingHorizontal: 2, marginVertical: 6, minHeight: 20, maxHeight: 120, lineHeight: 20, textAlignVertical: "center" as const, includeFontPadding: false } as const,
  remove: { position: "absolute", top: COMPOSER.removeBadgeInset, right: COMPOSER.removeBadgeInset, width: COMPOSER.removeBadge, height: COMPOSER.removeBadge, borderRadius: COMPOSER.removeBadge / 2, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" },
  sendBtn: { width: 32, height: 32, borderRadius: 12, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  sendBtnDisabled: { opacity: 0.4 },
  sendBadge: { position: "absolute", top: -6, right: -6, minWidth: 14, height: 14, paddingHorizontal: 2, borderRadius: 7, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd", color: "#666", fontSize: 9, fontWeight: "700", textAlign: "center", lineHeight: 12, overflow: "hidden" },
});
