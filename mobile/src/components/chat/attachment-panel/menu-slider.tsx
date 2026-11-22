import { useRef, useState, type ComponentRef } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { MENU } from "./constants";
import { type, withAlpha } from "@/theme";

/**
 * A stepped slider for the chat panel. Touch handling is the View's own responder
 * rather than gesture-handler: the panel sits in its own window over the keyboard,
 * outside the app's gesture root.
 * `value` undefined shows the thumb dimmed at `placeholder` (an "Auto" setting).
 */
export function MenuSlider({
  min,
  max,
  step,
  value,
  placeholder,
  format,
  onChange,
  fg,
  accent,
  label,
}: {
  min: number;
  max: number;
  step: number;
  value: number | undefined;
  placeholder: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  fg: string;
  accent: string;
  label: string;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  // Track's left edge in the window, read when a touch starts (handlers only).
  const trackX = useRef(0);
  const trackRef = useRef<ComponentRef<typeof View>>(null);

  const snap = (x: number, width: number) => {
    const t = Math.min(1, Math.max(0, width > 0 ? x / width : 0));
    const stepped = Math.round((t * (max - min)) / step) * step + min;
    // Trim float noise (0.30000000000000004).
    return Number(stepped.toFixed(4));
  };
  const set = (v: number) => {
    if (v !== value) onChange(v);
  };

  const shown = value ?? placeholder;
  const frac = (shown - min) / (max - min);
  const steps = Math.round((max - min) / step);
  const dim = withAlpha(fg, 0.55);

  return (
    <View
      style={styles.root}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: value == null ? "Auto" : format(value) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        const dir = e.nativeEvent.actionName === "increment" ? 1 : -1;
        onChange(Math.min(max, Math.max(min, Number((shown + dir * step).toFixed(4)))));
      }}
    >
      <View style={styles.readout}>
        <Text style={[styles.end, { color: dim }]}>{format(min)}</Text>
        <Text style={[styles.value, { color: value == null ? dim : fg }]}>{value == null ? "Auto" : format(value)}</Text>
        <Text style={[styles.end, { color: dim }]}>{format(max)}</Text>
      </View>
      <View
        ref={trackRef}
        style={styles.hit}
        onLayout={(e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width)}
        // The View's own responder (not gesture-handler): claim the touch and keep it
        // from the scroll view, so a sideways drag stays on the slider.
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => {
          const pageX = e.nativeEvent.pageX;
          trackRef.current?.measureInWindow((x, _y, w) => {
            trackX.current = x;
            set(snap(pageX - x, w));
          });
        }}
        onResponderMove={(e) => set(snap(e.nativeEvent.pageX - trackX.current, trackWidth))}
      >
        <View style={[styles.track, { backgroundColor: withAlpha(fg, 0.12) }]}>
          <View style={[styles.fill, { width: `${frac * 100}%`, backgroundColor: value == null ? withAlpha(fg, 0.25) : accent }]} />
        </View>
        {Array.from({ length: steps + 1 }, (_, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={[styles.tick, { left: (trackWidth * i) / steps - 1, backgroundColor: withAlpha(fg, 0.2) }]}
          />
        ))}
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            { left: trackWidth * frac - THUMB / 2, opacity: value == null ? 0.6 : 1, borderColor: withAlpha(fg, 0.12) },
          ]}
        />
      </View>
    </View>
  );
}

const THUMB = 26;

const styles = StyleSheet.create({
  root: { paddingHorizontal: MENU.iconInset, paddingTop: 6, paddingBottom: 10 },
  readout: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 },
  end: { ...type.caption },
  value: { ...type.title, fontVariant: ["tabular-nums"] },
  hit: { height: 36, justifyContent: "center" },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4 },
  tick: { position: "absolute", top: 14, width: 2, height: 8, borderRadius: 1 },
  thumb: {
    position: "absolute",
    top: (36 - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
});
