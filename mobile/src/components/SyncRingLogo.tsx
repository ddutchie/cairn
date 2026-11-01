import { useEffect, useState } from "react";
import { Animated, Easing, Image, View, type ImageSourcePropType } from "react-native";
import { ICON_CAIRN } from "@/components/toolbar-icons";
import { useSyncStatus } from "@/sync/useSyncStatus";
import { useTheme } from "@/theme";
import { useMotion } from "@/lib/use-motion";

const SIZE = 22;
const RING = 34;

/**
 * The Cairn logo with the sync state drawn around it as a ring: a quiet hairline
 * when synced, a warning ring when changes are pending, a muted ring when
 * offline, and a spinning arc while a sync is running. It replaces the old
 * standalone sync button, so status stays visible without a toolbar slot.
 */
export function SyncRingLogo() {
  const t = useTheme();
  const { state, pending } = useSyncStatus();
  const syncing = state === "syncing";
  const offline = state === "offline";
  const color = offline ? t.textTertiary : pending > 0 ? t.warning : t.success;

  // RN Animated doesn't follow Reduce Motion on its own (Reanimated does), so
  // the endless spin is gated here: reduced motion shows a still arc instead.
  const { reduced } = useMotion();
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!syncing || reduced) {
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [syncing, reduced, spin]);

  return (
    <View style={{ width: RING, height: RING, alignItems: "center", justifyContent: "center" }}>
      {syncing ? (
        <Animated.View
          style={{
            position: "absolute",
            width: RING,
            height: RING,
            borderRadius: RING / 2,
            borderWidth: 2,
            borderColor: "transparent",
            borderTopColor: t.accent,
            transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
          }}
        />
      ) : (
        <View
          style={{
            position: "absolute",
            width: RING,
            height: RING,
            borderRadius: RING / 2,
            borderWidth: pending > 0 || offline ? 2 : 1,
            borderColor: color,
            opacity: pending > 0 || offline ? 1 : 0.45,
          }}
        />
      )}
      <Image
        source={ICON_CAIRN as ImageSourcePropType}
        style={{ width: SIZE, height: SIZE, tintColor: t.accent }}
        accessibilityLabel="Switch workspace"
      />
    </View>
  );
}
