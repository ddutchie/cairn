import { useState, type ReactNode } from "react";
import { View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Root wrapper for root-stack screens (modals, sheets, pushed routes) on the
 * iPhone Duo's side-chrome insets.
 *
 * A static inset can't work here: the same route is full-window in one
 * posture (folded outer display, where content runs under the side chrome)
 * and a parked card in another (unfolded inner display, where the card never
 * reaches the rail and window insets would only squeeze it). So this measures
 * its own container: when it spans (nearly) the whole window the side insets
 * apply; when it's a narrower card they don't. Fold-safe (re-measures on
 * every layout), and a no-op wherever insets are 0.
 *
 * Tab screens must NOT use this — TabStack already insets them natively, and
 * this would double-pad. Likewise it must be the outermost flex:1 view so the
 * measured width is the native container's width.
 */
export function ModalSafeView({
  children,
  backgroundColor,
  style,
}: {
  children: ReactNode;
  backgroundColor: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { width: winW } = useWindowDimensions();
  const { left, right } = useSafeAreaInsets();
  const [w, setW] = useState<number | null>(null);
  // Unmeasured (first frame): assume full-window so a spanning modal never
  // flashes unclipped; cards correct themselves on layout, imperceptibly.
  const need = Math.max(left, right);
  const full = w == null || need === 0 || winW - w < need;
  return (
    <View
      onLayout={(e) => {
        const next = e.nativeEvent.layout.width;
        setW((prev) => (prev === next ? prev : next));
      }}
      style={[
        {
          flex: 1,
          backgroundColor,
          paddingLeft: full ? left : 0,
          paddingRight: full ? right : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
