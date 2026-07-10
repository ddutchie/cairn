import type { ReactNode } from "react";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import type { DragController } from "./useDragController";

/**
 * The floating clone that follows the finger while an item is lifted. Mount once
 * inside the drag container; it renders `children` (the caller's clone of the
 * dragged item) positioned under the finger via the controller's shared values.
 *
 * `dragX/Y` are window coords; we subtract the container's window origin so the
 * absolutely-positioned overlay lands under the finger, not offset below it.
 */
export function DragOverlay<T>({
  ctrl,
  children,
  scale = 1.04,
}: {
  ctrl: DragController<T>;
  children: ReactNode;
  scale?: number;
}) {
  const style = useAnimatedStyle(() => ({
    position: "absolute",
    top: 0,
    left: 0,
    width: ctrl.dragW.value,
    transform: [
      { translateX: ctrl.dragX.value - ctrl.originX.value },
      { translateY: ctrl.dragY.value - ctrl.originY.value },
      { scale },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={style}>
      {children}
    </Animated.View>
  );
}
