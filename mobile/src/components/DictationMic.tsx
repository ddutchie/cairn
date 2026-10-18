/* eslint-disable react-hooks/refs -- The PanResponder is built once (lazy state) and its
   handlers read these refs only when a touch arrives, never during render; the compiler
   rule can't see that through the closure. */
import { useEffect, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Mic, Square } from "lucide-react-native";
import { onPressIn, onPressOut, type MicMode } from "@/dictation/gesture";
import type { Dictation } from "@/dictation/useDictation";
import { useTheme, withAlpha } from "@/theme";

/**
 * The dictation button. One button, both habits (rules in `dictation/gesture.ts`):
 * tap to start and tap again to stop, or press and hold to listen only while held,
 * or slide left and release to cancel. While listening, the button shows a stop
 * square and a ring that swells with your voice.
 *
 * Uses PanResponder so a press, a hold and a slide are one continuous gesture with
 * no lag before listening starts.
 */
export function DictationMic({ dictation, size = 32 }: { dictation: Dictation; size?: number }) {
  const t = useTheme();
  const dictationRef = useRef(dictation);
  useEffect(() => {
    dictationRef.current = dictation;
  }, [dictation]);

  const mode = useRef<MicMode>("idle");
  const slide = useSharedValue(0);

  // If listening ends without our input (timeout, backgrounding, an error), the next
  // press must start a fresh session rather than act as a "stop" tap.
  useEffect(() => {
    if (!dictation.listening) mode.current = "idle";
  }, [dictation.listening]);

  const [responder] = useState(() => {
    let startMode: MicMode = "idle";
    let pressedAt = 0;
    const finish = (dx: number) => {
      const outcome = onPressOut(startMode, Date.now() - pressedAt, dx);
      mode.current = outcome.mode;
      if (outcome.action === "stop") dictationRef.current.stop();
      else if (outcome.action === "cancel") dictationRef.current.cancel();
      slide.set(withTiming(0, { duration: 160 }));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        startMode = mode.current;
        pressedAt = Date.now();
        slide.set(0);
        if (onPressIn(mode.current) === "start") {
          void dictationRef.current.start().then((ok) => {
            if (!ok) mode.current = "idle";
          });
        }
      },
      onPanResponderMove: (_e, g) => slide.set(Math.min(0, g.dx)),
      onPanResponderRelease: (_e, g) => finish(g.dx),
      onPanResponderTerminate: () => finish(0),
    });
  });

  const ringStyle = useAnimatedStyle(() => ({
    opacity: dictation.listening ? 0.35 : 0,
    transform: [{ scale: 1 + dictation.level.get() * 0.9 }],
  }));
  const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateX: slide.get() }] }));

  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden={false}>
      <Animated.View
        pointerEvents="none"
        style={[styles.ring, { width: size, height: size, borderRadius: size * 0.4, backgroundColor: t.accent }, ringStyle]}
      />
      <Animated.View style={slideStyle} {...responder.panHandlers}>
        <Pressable
          // Touches are handled by the PanResponder; Pressable gives screen readers a button
          // and a way to act without the gesture (double-tap toggles).
          accessibilityRole="button"
          accessibilityLabel={dictation.listening ? "Stop dictation" : "Dictate"}
          accessibilityHint="Press and hold to talk, or tap to start and stop. Slide left to cancel."
          accessibilityActions={[{ name: "activate" }]}
          onAccessibilityAction={() => (dictation.listening ? dictation.stop() : void dictation.start())}
          style={[
            styles.button,
            { width: size, height: size, borderRadius: size * 0.4, backgroundColor: dictation.listening ? t.danger : t.accent },
          ]}
        >
          {dictation.listening ? (
            <Square size={size * 0.38} color={withAlpha(t.accentFg, 1)} fill={t.accentFg} />
          ) : (
            <Mic size={size * 0.46} color={t.accentFg} />
          )}
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: "absolute", left: 0, top: 0 },
  button: { alignItems: "center", justifyContent: "center" },
});
