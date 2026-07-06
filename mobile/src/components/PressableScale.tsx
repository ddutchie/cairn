import { forwardRef, useCallback } from "react";
import { Pressable, type PressableProps, type View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withSpring,
  type AnimatedStyle,
} from "react-native-reanimated";
import type { StyleProp, ViewStyle } from "react-native";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, "style"> {
  /** Scale to shrink to while pressed. Default 0.97 (desktop uses active:scale-95). */
  scaleTo?: number;
  /** Opacity while pressed. Default 0.92. Set to 1 to disable the fade. */
  dimTo?: number;
  style?: StyleProp<ViewStyle>;
  /** Extra animated style merged on top (e.g. layout transitions). */
  animatedStyle?: AnimatedStyle<ViewStyle>;
}

/**
 * A Pressable with a spring scale + opacity press feedback — the mobile
 * analogue of the desktop's `hover:scale-105 active:scale-95` micro-interaction
 * (src/components/chat/ChatInput.tsx). Use it anywhere a tappable row, card, or
 * button needs to feel alive instead of static.
 *
 * Press-in shrinks/dims instantly-ish; release springs back. Honours disabled.
 */
export const PressableScale = forwardRef<View, PressableScaleProps>(function PressableScale(
  { scaleTo = 0.97, dimTo = 0.92, style, animatedStyle, onPressIn, onPressOut, disabled, children, ...rest },
  ref,
) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const handlePressIn = useCallback<NonNullable<PressableProps["onPressIn"]>>(
    (e) => {
      if (!disabled) {
        scale.value = withTiming(scaleTo, { duration: 90 });
        opacity.value = withTiming(dimTo, { duration: 90 });
      }
      onPressIn?.(e);
    },
    [disabled, scaleTo, dimTo, onPressIn, scale, opacity],
  );

  const handlePressOut = useCallback<NonNullable<PressableProps["onPressOut"]>>(
    (e) => {
      scale.value = withSpring(1, { damping: 15, stiffness: 260, mass: 0.4 });
      opacity.value = withTiming(1, { duration: 140 });
      onPressOut?.(e);
    },
    [onPressOut, scale, opacity],
  );

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <AnimatedPressable
      ref={ref}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[style, pressStyle, animatedStyle]}
      {...rest}
    >
      {children as React.ReactNode}
    </AnimatedPressable>
  );
});
