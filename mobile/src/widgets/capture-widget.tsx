import { HStack, Image, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import { Circle } from "@expo/ui/swift-ui";
import { containerBackground, font, foregroundStyle, frame, opacity, widgetURL } from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

export interface CaptureColors {
  accent: string;
  accentFg: string;
}

export interface CaptureWidgetProps {
  light: CaptureColors;
  dark: CaptureColors;
}

/**
 * Quick Capture — one big target that opens the capture sheet (`cairn://capture`).
 * Widgets can't take typed input, so a tap hands straight over to the app.
 * Fully self-contained (isolated widget runtime): theme colours arrive as props.
 */
function CaptureWidget(props: CaptureWidgetProps, env: WidgetEnvironment) {
  "widget";
  const c = env.colorScheme === "dark" ? props.dark : props.light;
  if (env.widgetFamily === "accessoryCircular") {
    return (
      <ZStack modifiers={[widgetURL("cairn://capture")]}>
        <Image systemName="square.and.pencil" size={22} />
      </ZStack>
    );
  }
  const medium = env.widgetFamily !== "systemSmall";
  const badge = (
    <ZStack modifiers={[frame({ width: medium ? 56 : 44, height: medium ? 56 : 44 })]}>
      <Circle modifiers={[foregroundStyle(c.accentFg), opacity(0.2)]} />
      <Image systemName="square.and.pencil" size={medium ? 26 : 20} color={c.accentFg} />
    </ZStack>
  );
  const label = (
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ size: medium ? 20 : 17, weight: "bold", design: "rounded" }), foregroundStyle(c.accentFg)]}>
        Quick capture
      </Text>
      <Text modifiers={[font({ size: 12 }), foregroundStyle(c.accentFg), opacity(0.75)]}>
        {medium ? "A thought, a to-do, a link…" : "Tap to jot it down"}
      </Text>
    </VStack>
  );
  return (
    <ZStack alignment="topLeading" modifiers={[frame({ maxWidth: 10000, maxHeight: 10000 }), containerBackground(c.accent, "widget"), widgetURL("cairn://capture")]}>
      {medium ? (
        <HStack alignment="center" spacing={14} modifiers={[frame({ maxWidth: 10000, maxHeight: 10000, alignment: "leading" })]}>
          {badge}
          {label}
          <Spacer />
        </HStack>
      ) : (
        <VStack alignment="leading" spacing={0} modifiers={[frame({ maxWidth: 10000, maxHeight: 10000, alignment: "topLeading" })]}>
          {badge}
          <Spacer />
          {label}
        </VStack>
      )}
    </ZStack>
  );
}

export const captureWidget = createWidget<CaptureWidgetProps>("CairnCapture", CaptureWidget, {
  light: { accent: "#5c7a3f", accentFg: "#ffffff" },
  dark: { accent: "#8faf6f", accentFg: "#10130d" },
});
