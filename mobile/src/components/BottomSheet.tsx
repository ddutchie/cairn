import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  View,
  KeyboardAvoidingView,
  Platform,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import { useTheme, elevation, type as typeScale, type Theme } from "@/theme";
import { haptics } from "@/haptics";

/**
 * Shared bottom-sheet scaffold for contextual pickers (due date, tags,
 * wikilinks). Unlike a raw `<Modal animationType="slide">` — which slides the
 * *entire* surface including the dim backdrop up from the bottom (an odd feel)
 * — this animates the backdrop opacity and the card's translateY
 * independently: the backdrop fades in while only the card slides up. The
 * enter/exit is driven manually, so we keep the Modal mounted through the exit
 * animation before unmounting.
 *
 * For standalone configuration screens (e.g. AI settings) prefer a native
 * `presentation: "formSheet"` route instead of this component.
 */
export function BottomSheet({
  visible,
  onClose,
  children,
  maxHeight,
  avoidKeyboard = false,
  contentStyle,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** e.g. "70%" or a number. Omit to size to content. */
  maxHeight?: ViewStyle["maxHeight"];
  /** Lift the sheet above the keyboard (pickers with a text input). */
  avoidKeyboard?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  // Keep the Modal mounted for the duration of the EXIT animation. When
  // `visible` is true we render immediately (no state write needed); this flag
  // only extends mounting past a close so the slide-out can play. Deriving the
  // render condition from `visible || exiting` avoids a setState-in-effect.
  const [exiting, setExiting] = useState(false);
  // Lazily create the driver once (useState initialiser, not useRef, so the
  // react-hooks lint rule doesn't flag reading a ref value during render).
  const [progress] = useState(() => new Animated.Value(0)); // 0 = hidden, 1 = shown
  // Tracks whether the sheet has ever been opened, so an initial `visible=false`
  // render doesn't trigger a spurious exit animation / mount flash.
  const wasVisible = useRef(false);

  useEffect(() => {
    if (visible) {
      // Opening: `exiting` is already false in the steady state; we deliberately
      // do NOT setState here (a synchronous setState-in-effect triggers a
      // cascading render). Just play the enter animation.
      wasVisible.current = true;
      haptics.impact(); // subtle tap as any sheet/modal opens (central hook)
      Animated.timing(progress, {
        toValue: 1,
        duration: 240,
        useNativeDriver: true,
      }).start();
    } else if (wasVisible.current) {
      // Play the exit animation, keeping the sheet mounted until it finishes.
      wasVisible.current = false;
      setExiting(true);
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(({ finished }) => {
        // Only unmount if we didn't get reopened mid-exit (wasVisible flips true
        // again in that case).
        if (finished && !wasVisible.current) setExiting(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible && !exiting) return null;

  const backdropOpacity = progress; // 0 → 1
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [600, 0], // slide up from below; large enough for tall sheets
  });

  const card = (
    <Animated.View
      style={[
        styles.sheet,
        elevation.xl,
        maxHeight != null && { maxHeight },
        { transform: [{ translateY }] },
        contentStyle,
      ]}
    >
      <View style={styles.grabber} />
      {children}
    </Animated.View>
  );

  const body = (
    <View style={styles.fill}>
      {/* Backdrop fades independently of the card slide. */}
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={styles.fill} onPress={onClose} />
      </Animated.View>
      <View style={styles.anchor} pointerEvents="box-none">
        {card}
      </View>
    </View>
  );

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        body
      )}
    </Modal>
  );
}

/** Standard sheet header with Cancel / title / (optional) Done. */
export function BottomSheetHeader({
  title,
  onCancel,
  onDone,
}: {
  title: string;
  onCancel: () => void;
  onDone?: () => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.header}>
      <Pressable onPress={onCancel} hitSlop={12} accessibilityRole="button" accessibilityLabel="Cancel">
        <Animated.Text style={styles.cancel}>Cancel</Animated.Text>
      </Pressable>
      <Animated.Text style={styles.title}>{title}</Animated.Text>
      {onDone ? (
        <Pressable onPress={onDone} hitSlop={12} accessibilityRole="button" accessibilityLabel="Done">
          <Animated.Text style={styles.done}>Done</Animated.Text>
        </Pressable>
      ) : (
        <View style={styles.headerSpacer} />
      )}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    fill: { flex: 1 },
    backdrop: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.scrim,
    },
    anchor: { flex: 1, justifyContent: "flex-end" },
    sheet: {
      backgroundColor: t.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingBottom: 34,
    },
    grabber: {
      alignSelf: "center",
      width: 40,
      height: 5,
      borderRadius: 3,
      backgroundColor: t.border,
      marginTop: 8,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    title: { ...typeScale.subtitle, fontWeight: "700", color: t.textPrimary },
    cancel: { ...typeScale.subtitle, fontWeight: "400", color: t.textTertiary },
    done: { ...typeScale.subtitle, color: t.accent },
    headerSpacer: { width: 48 },
  });
}
