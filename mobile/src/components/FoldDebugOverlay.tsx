import { Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEffect } from "react";
import { useFold } from "@/lib/use-fold";
import { useHingeStatus } from "@/lib/hinge";
import { useFoldOverlay } from "@/lib/dev-flags";

/**
 * Dev-only readout for iPhone Duo pose work: window size, safe-area insets and
 * hinge status along the top, plus a translucent band where the inferred crease
 * is (see `src/lib/fold.ts`) — the simulator's screenshots never draw the fold.
 * Switched on in Settings → Appearance → Developer; absent from release builds.
 */
export function FoldDebugOverlay() {
  const on = useFoldOverlay();
  return on ? <Overlay /> : null;
}

function Overlay() {
  const { width, height, scale } = useWindowDimensions();
  const i = useSafeAreaInsets();
  const hinge = useHingeStatus();
  const fold = useFold();
  const line = `${Math.round(width)}x${Math.round(height)} @${scale}  T${Math.round(i.top)} B${Math.round(i.bottom)} L${Math.round(i.left)} R${Math.round(i.right)}  hinge=${hinge ?? "null"}`;
  useEffect(() => {
    console.log("[fold-debug]", line);
  }, [line]);
  return (
    <>
      {fold && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            zIndex: 9998,
            backgroundColor: "rgba(255,0,0,0.25)",
            ...(fold.axis === "horizontal"
              ? { left: 0, right: 0, top: fold.position - fold.gutter / 2, height: fold.gutter }
              : { top: 0, bottom: 0, left: fold.position - fold.gutter / 2, width: fold.gutter }),
          }}
        />
      )}
      <View
        pointerEvents="none"
        style={{ position: "absolute", top: 2, left: 0, right: 0, alignItems: "center", zIndex: 9999 }}
      >
        <Text style={{ fontSize: 10, color: "#fff", backgroundColor: "#d00", paddingHorizontal: 4 }}>{line}</Text>
      </View>
    </>
  );
}
