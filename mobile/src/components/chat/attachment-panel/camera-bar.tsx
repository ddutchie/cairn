import type { FlashMode } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ChevronLeft, Ellipsis, X, Zap, ZapOff, SwitchCamera } from "lucide-react-native";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { BOTTOM_BAR, CAMERA, COLORS, DURATION, GUTTER, SPRING } from "./constants";
import { Glass } from "./glass";

function Option({
  index,
  label,
  icon: IconCmp,
  unfold,
  active,
  fade,
  onPress,
}: {
  index: number;
  label: string;
  icon: typeof Zap;
  unfold: SharedValue<number>;
  active: boolean;
  fade: SharedValue<number>;
  onPress: () => void;
}) {
  const rise = index * (CAMERA.optionSize + CAMERA.optionGap);
  const style = useAnimatedStyle(() => {
    const u = unfold.get();
    return {
      transform: [{ translateY: -rise * u }, { scale: interpolate(u, [0, 1], [CAMERA.optionStartScale, 1], Extrapolation.EXTEND) }],
    };
  });
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(unfold.get(), [0.2, 0.8], [0, 1], Extrapolation.CLAMP) * fade.get(),
  }));
  return (
    <Animated.View pointerEvents={active ? "auto" : "none"} style={[styles.option, style]}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
        <Glass radius={CAMERA.optionSize / 2} active={active} duration={DURATION.crossfade / 1000} style={styles.round}>
          <Animated.View style={iconStyle}>
            <IconCmp size={CAMERA.optionIcon} color={COLORS.text} />
          </Animated.View>
        </Glass>
      </Pressable>
    </Animated.View>
  );
}

export function CameraBar({
  width,
  active,
  fade,
  flash,
  onBack,
  onCapture,
  onFlip,
  onToggleFlash,
}: {
  width: number;
  active: boolean;
  fade: SharedValue<number>;
  flash: FlashMode;
  onBack: () => void;
  onCapture: () => void;
  onFlip: () => void;
  onToggleFlash: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unfold = useSharedValue(0);
  const toggleOptions = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOpen((was) => {
      unfold.set(withSpring(was ? 0 : 1, was ? SPRING.panelOut : SPRING.panel));
      return !was;
    });
  }, [unfold]);
  const contentStyle = useAnimatedStyle(() => ({ opacity: fade.get() }));
  const dotsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(unfold.get(), [0, 0.5], [1, 0], Extrapolation.CLAMP) * fade.get(),
  }));
  const closeStyle = useAnimatedStyle(() => {
    const u = unfold.get();
    return { opacity: interpolate(u, [0.3, 0.8], [0, 1], Extrapolation.CLAMP) * fade.get(), transform: [{ rotate: `${interpolate(u, [0, 1], [-90, 0])}deg` }] };
  });

  return (
    <View pointerEvents={active ? "box-none" : "none"} style={[styles.bar, { width }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to menu" onPress={onBack}>
        <Glass radius={BOTTOM_BAR.backSize / 2} active={active} duration={DURATION.crossfade / 1000} style={styles.round}>
          <Animated.View style={contentStyle}>
            <ChevronLeft size={BOTTOM_BAR.backIcon} color={COLORS.text} />
          </Animated.View>
        </Glass>
      </Pressable>
      <View pointerEvents="box-none" style={styles.shutterSlot}>
        <Pressable accessibilityRole="button" accessibilityLabel="Take photo" onPress={onCapture}>
          <Glass radius={CAMERA.shutterSize / 2} active={active} duration={DURATION.crossfade / 1000} style={styles.shutter}>
            <Animated.View style={[styles.shutterDisc, contentStyle]} />
          </Glass>
        </Pressable>
      </View>
      <View style={styles.more}>
        <Option index={2} label={flash === "off" ? "Turn flash on" : "Turn flash off"} icon={flash === "off" ? ZapOff : Zap} unfold={unfold} active={active && open} fade={fade} onPress={onToggleFlash} />
        <Option index={1} label="Flip camera" icon={SwitchCamera} unfold={unfold} active={active && open} fade={fade} onPress={onFlip} />
        <Pressable accessibilityRole="button" accessibilityLabel={open ? "Hide camera options" : "Camera options"} accessibilityState={{ expanded: open }} onPress={toggleOptions}>
          <Glass radius={CAMERA.optionSize / 2} active={active} duration={DURATION.crossfade / 1000} style={styles.round}>
            <Animated.View style={[styles.glyph, dotsStyle]}>
              <Ellipsis size={CAMERA.optionIcon} color={COLORS.text} />
            </Animated.View>
            <Animated.View style={[styles.glyph, closeStyle]}>
              <X size={BOTTOM_BAR.backIcon} color={COLORS.text} />
            </Animated.View>
          </Glass>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: GUTTER,
    bottom: GUTTER + BOTTOM_BAR.inset,
    height: CAMERA.optionSize,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: BOTTOM_BAR.inset,
  },
  round: { width: CAMERA.optionSize, height: CAMERA.optionSize, alignItems: "center", justifyContent: "center" },
  glyph: { position: "absolute", alignItems: "center", justifyContent: "center" },
  option: { position: "absolute", left: 0, bottom: 0, width: CAMERA.optionSize, height: CAMERA.optionSize, alignItems: "center", justifyContent: "center" },
  more: { width: CAMERA.optionSize, height: CAMERA.optionSize, alignItems: "center", justifyContent: "center" },
  shutterSlot: { flex: 1, alignItems: "center", justifyContent: "center" },
  shutter: { width: CAMERA.shutterSize, height: CAMERA.shutterSize, alignItems: "center", justifyContent: "center" },
  shutterDisc: { width: CAMERA.shutterSize - CAMERA.shutterPadding * 2, height: CAMERA.shutterSize - CAMERA.shutterPadding * 2, borderRadius: (CAMERA.shutterSize - CAMERA.shutterPadding * 2) / 2, backgroundColor: "#fff" },
});
