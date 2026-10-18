import { useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Canvas, Group, RoundedRect } from "@shopify/react-native-skia";
import {
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { haptics } from "@/haptics";
import { layoutStones, STACK_WIDTH, type StoneInput } from "@/gamification/stones";
import { useTheme, withAlpha } from "@/theme";

/** Room above the pile for the newest stone to fall from. */
const DROP_PAD = 28;
const DROP_FROM = -DROP_PAD;
const RADIUS = 9;

/**
 * "Your cairn": the most recent notes as a balanced stack of stones, newest on
 * top in the accent colour — the app's logo, built from your own work. Add a
 * note and a new stone drops onto the pile with a settling haptic. Tap a stone
 * to open that note.
 *
 * Drawing is Skia (one canvas, theme colours only); tap targets are plain
 * Pressables laid over each stone so they're real, accessible buttons. With
 * reduced motion the new stone just appears.
 */
export function CairnStack({
  inputs,
  newestId,
  onOpen,
  width = STACK_WIDTH,
}: {
  inputs: readonly StoneInput[];
  newestId: string | null;
  onOpen: (stone: { projectId: string; id: string }) => void;
  width?: number;
}) {
  const t = useTheme();
  const reduceMotion = useReducedMotion();
  const { stones, height } = useMemo(() => layoutStones(inputs, { width }), [inputs, width]);

  // The first newest id we see is the app's existing state, not an arrival.
  const seenNewest = useRef<string | null | undefined>(undefined);
  const drop = useSharedValue(0);
  const fade = useSharedValue(1);
  useEffect(() => {
    const prev = seenNewest.current;
    seenNewest.current = newestId;
    if (prev === undefined || prev === newestId || newestId === null) return;
    if (reduceMotion) return;
    drop.set(DROP_FROM);
    fade.set(0);
    fade.set(withTiming(1, { duration: 140 }));
    drop.set(withSpring(0, { damping: 11, stiffness: 150, mass: 0.8 }));
    const timer = setTimeout(() => haptics.settle(), 210);
    return () => clearTimeout(timer);
  }, [newestId, reduceMotion, drop, fade]);

  const dropTransform = useDerivedValue(() => [{ translateY: drop.get() }]);
  const topOpacity = useDerivedValue(() => fade.get());

  if (stones.length === 0) return null;
  const canvasH = height + DROP_PAD;

  return (
    <View style={{ width, height: canvasH }}>
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        {stones.map((s) => {
          const body = (
            <Group
              key={s.id}
              transform={[{ rotate: (s.rotate * Math.PI) / 180 }]}
              origin={{ x: s.x + s.w / 2, y: s.y + DROP_PAD + s.h / 2 }}
            >
              <RoundedRect x={s.x} y={s.y + DROP_PAD} width={s.w} height={s.h} r={RADIUS} color={s.top ? t.accent : t.surface3} />
              {!s.top && (
                <RoundedRect x={s.x} y={s.y + DROP_PAD} width={s.w} height={s.h} r={RADIUS} color={withAlpha(t.accent, 0.06 + 0.2 * s.tone)} />
              )}
              <RoundedRect
                x={s.x + 0.5}
                y={s.y + DROP_PAD + 0.5}
                width={s.w - 1}
                height={s.h - 1}
                r={RADIUS}
                color={s.top ? withAlpha(t.accentFg, 0.25) : t.border}
                style="stroke"
                strokeWidth={1}
              />
            </Group>
          );
          return s.top ? (
            <Group key={s.id} transform={dropTransform} opacity={topOpacity}>
              {body}
            </Group>
          ) : (
            body
          );
        })}
      </Canvas>
      {stones.map((s) => (
        <Pressable
          key={s.id}
          style={{ position: "absolute", left: s.x, top: s.y + DROP_PAD, width: s.w, height: s.h }}
          onPress={() => {
            haptics.selection();
            onOpen({ projectId: s.projectId, id: s.id });
          }}
          accessibilityRole="button"
          accessibilityLabel={s.title || "Untitled note"}
          hitSlop={{ top: 2, bottom: 2 }}
        />
      ))}
    </View>
  );
}
