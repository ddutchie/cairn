import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";

/**
 * `KeyboardStickyView`, minus one failure: after the window rotates (iPhone Duo
 * unfolded, landscape → portrait) the library's keyboard `progress` can be left
 * at 1 while the keyboard height is 0. It then applies the *opened* offset to a
 * closed keyboard, and the composer rests a few points above the screen's bottom
 * edge — behind the tab bar — until the screen is left and re-entered.
 *
 * Here a zero keyboard height always means "closed", whatever `progress` says.
 * While the keyboard is moving the height is non-zero, so its progress is used as
 * before and the motion is identical.
 */
export function RestingStickyView({
  offset,
  style,
  children,
  pointerEvents,
}: {
  /** translateY added when the keyboard is closed / open. */
  offset: { closed: number; opened: number };
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  pointerEvents?: "auto" | "none" | "box-none" | "box-only";
}) {
  const { height, progress } = useReanimatedKeyboardAnimation();
  const { closed, opened } = offset;
  const sticky = useAnimatedStyle(() => {
    const h = height.get();
    const p = Math.abs(h) < 0.5 ? 0 : progress.get();
    return { transform: [{ translateY: h + interpolate(p, [0, 1], [closed, opened]) }] };
  }, [closed, opened]);
  return (
    <Animated.View style={[style, sticky]} pointerEvents={pointerEvents}>
      {children}
    </Animated.View>
  );
}
