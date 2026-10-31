import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useMotion } from "@/lib/use-motion";

/** Critically damped: the panel settles without overshooting, which a height cannot do. */
const SPRING = { damping: 26, stiffness: 260, mass: 1, overshootClamping: true } as const;

export interface DisclosureState {
  /** 0 = closed, 1 = open. Drive a chevron's rotation from it. */
  progress: SharedValue<number>;
  /** True from the moment it starts opening until it has finished closing. */
  mounted: boolean;
  /** True only while the spring is running. At rest the body is plain, auto-sized layout. */
  animating: boolean;
  /** Natural height of the content; written by the body's layout. */
  contentHeight: SharedValue<number>;
}

/**
 * Open/close state for a disclosure. The body animates its height only while the spring runs;
 * at rest it is ordinary auto-height content, so text that keeps growing underneath (a streaming
 * reasoning trace) re-lays-out exactly as it did before and never fights the chat's scroll
 * anchoring. Reduce motion toggles instantly.
 */
export function useDisclosure(open: boolean): DisclosureState {
  const motion = useMotion();
  const progress = useSharedValue(open ? 1 : 0);
  const contentHeight = useSharedValue(0);
  const [seenOpen, setSeenOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  const [animating, setAnimating] = useState(false);

  // A flip of `open` starts the spring (or closes instantly under reduce motion). Doing this while
  // rendering, not in an effect, means the first frame of the change already has the right state.
  if (seenOpen !== open) {
    setSeenOpen(open);
    setClosing(!open && !motion.reduced);
    setAnimating(!motion.reduced);
  }

  useEffect(() => {
    if (motion.reduced) {
      progress.set(open ? 1 : 0);
      return;
    }
    const done = () => {
      setAnimating(false);
      setClosing(false);
    };
    progress.set(
      withSpring(open ? 1 : 0, SPRING, (finished) => {
        if (finished) scheduleOnRN(done);
      }),
    );
  }, [open, motion.reduced, progress]);

  const mounted = open || closing;
  return { progress, mounted, animating: animating && !motion.reduced, contentHeight };
}

/** The collapsible body. Renders nothing while closed. */
export function DisclosureBody({ state, children }: { state: DisclosureState; children: ReactNode }) {
  const { progress, contentHeight, mounted, animating } = state;
  const clip = useAnimatedStyle(() => ({
    height: contentHeight.get() * progress.get(),
    opacity: progress.get(),
  }));
  if (!mounted) return null;
  return (
    <Animated.View style={animating ? [{ overflow: "hidden" }, clip] : undefined}>
      <View onLayout={(e) => contentHeight.set(e.nativeEvent.layout.height)}>{children}</View>
    </Animated.View>
  );
}

/** A chevron-sized wrapper that turns a quarter as the disclosure opens. */
export function DisclosureTurn({ progress, children }: { progress: SharedValue<number>; children: ReactNode }) {
  const turn = useAnimatedStyle(() => ({ transform: [{ rotate: `${progress.get() * 90}deg` }] }));
  return <Animated.View style={turn}>{children}</Animated.View>;
}
