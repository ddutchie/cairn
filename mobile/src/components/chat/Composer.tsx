import { useMemo } from "react";
import {
  View,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import Animated from "react-native-reanimated";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Send, ImagePlus, X } from "lucide-react-native";
import { Button } from "@expo/ui/swift-ui";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { GlassMenu } from "@/components/GlassMenu";
import { useTheme, withAlpha, KEYBOARD_OPEN_GAP, type as typeScale, type Theme } from "@/theme";
import type { Attachment } from "@/chat/agent";

export interface ComposerProps {
  input: string;
  onChangeInput: (v: string) => void;
  attachments: Attachment[];
  onRemoveAttachment: (idx: number) => void;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  onInputFocus: () => void;
  /** Native attach-menu actions + fallback (iOS action sheet / Alert). */
  onAddImages: () => void;
  onCapturePhoto: () => void;
  onAttachFallback: () => void;
  /** From useChatScroll: keeps the native attach Host from drifting on open. */
  attachCounterStyle: StyleProp<ViewStyle>;
  /** From useChatScroll: how far the composer rests above the tab bar (closed). */
  closedLift: number;
  /** Report the measured composer height back to the scroll padding logic. */
  onLayoutHeight: (h: number) => void;
}

/**
 * The bottom composer: a KeyboardStickyView pinned to the screen bottom that
 * rides up with the keyboard. Holds the attachment preview strip and a single
 * rounded GlassBar with the attach menu, multiline input, and send button.
 * Mirrors the desktop overview `ChatInput`.
 */
export function Composer({
  input,
  onChangeInput,
  attachments,
  onRemoveAttachment,
  busy,
  canSend,
  onSend,
  onInputFocus,
  onAddImages,
  onCapturePhoto,
  onAttachFallback,
  attachCounterStyle,
  closedLift,
  onLayoutHeight,
}: ComposerProps) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    // Sticky composer: pinned to the bottom, rides up with the keyboard
    // automatically. When the keyboard is closed it's offset up above the
    // translucent tab bar; when open it sits just above the keyboard with a
    // small gap (KEYBOARD_OPEN_GAP), matching the search scope bar.
    <KeyboardStickyView
      offset={{ closed: -closedLift, opened: -KEYBOARD_OPEN_GAP }}
      style={styles.composerOverlay}
    >
      <View onLayout={(e) => onLayoutHeight(e.nativeEvent.layout.height)}>
        {attachments.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.previewStrip} contentContainerStyle={styles.previewContent}>
            {attachments.map((a, i) => (
              <View key={i} style={styles.previewItem}>
                <Image source={{ uri: a.url }} style={styles.previewImg} />
                <Pressable style={styles.previewRemove} onPress={() => onRemoveAttachment(i)} hitSlop={6}>
                  <X size={12} color="#fff" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        <View style={styles.composerWrap}>
          <GlassBar style={styles.composer} interactive={false}>
            {/* Native SwiftUI GlassMenu (Liquid Glass tap-menu), wrapped in
                a fixed-size slot so the async-measuring Host can't reflow the
                row. NOTE: the composer rides KeyboardStickyView's transform;
                a SwiftUI Host re-anchors in window coords on menu-open, which
                historically made the icon drift after tapping with the
                keyboard open. Verifying the raw behaviour before mitigating. */}
            <View style={styles.attachSlot}>
              <Animated.View style={attachCounterStyle}>
                <GlassMenu
                  trigger={<ImagePlus size={16} color={busy ? withAlpha(t.textTertiary, 0.5) : t.textTertiary} />}
                  accessibilityLabel="Add image"
                  disabled={busy}
                  onFallbackPress={onAttachFallback}
                  containerStyle={styles.attachContainer}
                  triggerStyle={styles.attachBtn}
                >
                  <Button label="Photo Library" systemImage="photo.on.rectangle" onPress={onAddImages} />
                  <Button label="Take Photo" systemImage="camera" onPress={onCapturePhoto} />
                </GlassMenu>
              </Animated.View>
            </View>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={onChangeInput}
              onFocus={onInputFocus}
              placeholder="Message Cairn…"
              placeholderTextColor={t.textTertiary}
              multiline
              editable={!busy}
            />
            <Pressable
              style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
              onPress={onSend}
              disabled={!canSend}
            >
              {busy ? <ActivityIndicator color={t.accentFg} size="small" /> : <Send size={14} color={t.accentFg} />}
            </Pressable>
          </GlassBar>
        </View>
      </View>
    </KeyboardStickyView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    previewStrip: { maxHeight: 84, marginHorizontal: 12 },
    previewContent: { gap: 8, paddingVertical: 6 },
    previewItem: { position: "relative" },
    previewImg: { width: 68, height: 68, borderRadius: 10, backgroundColor: t.surface3 },
    previewRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" },
    // The composer overlay is absolutely pinned to the bottom of the screen and
    // lifted above the tab bar / keyboard via an animated transform. It sits ON
    // TOP of the scroll content so messages scroll behind it.
    composerOverlay: { position: "absolute", left: 0, right: 0, bottom: 0 },
    // Outer padding around the pinned composer (mirrors desktop overview `p-6`
    // overlay, trimmed for mobile).
    composerWrap: { paddingHorizontal: 12, paddingTop: 8 },
    // Single unified rounded container holding attach + input + send inline,
    // mirroring the desktop overview ChatInput: rounded-2xl (16px), frosted
    // surface-2 at ~85%, 1px border, soft drop shadow. Buttons align to the
    // bottom edge (items-end) so a multiline field grows upward.
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 10,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderRadius: 16,
      overflow: "hidden",
      // When Liquid Glass is active the GlassView is the visual container, so no
      // border/fill — the border only defines the fallback (non-glass) surface.
      backgroundColor: glassActive ? undefined : withAlpha(t.surface2, 0.92),
      borderWidth: glassActive ? 0 : 1,
      borderColor: glassActive ? undefined : t.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.12,
      shadowRadius: 30,
      elevation: 4,
    },
    input: {
      flex: 1,
      minHeight: 36,
      maxHeight: 132,
      color: t.textPrimary,
      ...typeScale.body,
      lineHeight: 21,
      paddingVertical: 6,
      paddingHorizontal: 2,
    },
    // Fixed-height RN wrapper so the native Host can't reflow the composer row
    // when it (async) measures its content. Centered like the send button.
    attachSlot: { height: 36, justifyContent: "center", alignSelf: "center" },
    // Host frame hint (the outermost @expo/ui Host element / flex child).
    attachContainer: { width: 32, height: 32, alignSelf: "center" },
    // 32px rounded icon button, vertically centred against the input (alignSelf
    // overrides the row's flex-end so it doesn't ride up as the input grows).
    // Used as the GlassMenu trigger; a counter-transform keeps the native Host
    // from drifting when the keyboard opens (see attachCounterStyle).
    attachBtn: {
      width: 32,
      height: 32,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "center",
    },
    sendBtn: {
      width: 32,
      height: 32,
      borderRadius: 12,
      backgroundColor: t.accent,
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "center",
    },
    sendBtnDisabled: { opacity: 0.4 },
  });
}
