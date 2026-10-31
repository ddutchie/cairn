import { useRef, useState, type ReactNode } from "react";
import Animated, { FadeInDown } from "react-native-reanimated";
import { staggerDelay } from "@/lib/motion";
import { useMotion } from "@/lib/use-motion";

const ENTER_MS = 260;

/**
 * Remembers which rows have already played their entrance for the current result set, so a row
 * that remounts (scrolled away and back, or a list recycling it) never animates twice. Pass a
 * `setKey` that changes when a genuinely new set begins (e.g. "empty" while there are no
 * results), which clears the memory.
 */
export function useStaggerGate(setKey: string): (id: string) => boolean {
  const memory = useRef<{ key: string; seen: Set<string> }>({ key: setKey, seen: new Set() });
  return (id) => {
    if (memory.current.key !== setKey) memory.current = { key: setKey, seen: new Set() };
    if (memory.current.seen.has(id)) return false;
    memory.current.seen.add(id);
    return true;
  };
}

/**
 * Wraps a list row so it fades up on first appearance, staggered by its index. Only the first
 * few rows animate (`staggerDelay` returns null past the cap), and reduce motion skips it. The
 * decision is made once at mount, so it is safe inside a virtualised list.
 */
export function StaggerIn({ id, index, gate, children }: { id: string; index: number; gate: (id: string) => boolean; children: ReactNode }) {
  const motion = useMotion();
  const [entering] = useState(() => {
    if (!gate(id)) return undefined;
    const delay = staggerDelay(index, { reduced: motion.reduced });
    return delay === null ? undefined : FadeInDown.delay(delay).duration(ENTER_MS);
  });
  return <Animated.View entering={entering}>{children}</Animated.View>;
}
