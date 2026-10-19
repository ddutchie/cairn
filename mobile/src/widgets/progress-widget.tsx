import { Gauge, HStack, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { containerBackground, font, foregroundStyle, frame, gaugeStyle, lineLimit, tint, widgetURL } from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

/** The Cairn theme tokens the widget needs, resolved by the app (accent preset included). */
export interface WidgetColors {
  surface: string;
  accent: string;
  textPrimary: string;
  textTertiary: string;
  warning: string;
  danger: string;
}

/** One renderable card: the whole workspace, or a single project. */
export interface WidgetCard {
  /** Workspace or project name. */
  title: string;
  completion: number;
  doneCards: number;
  totalCards: number;
  openCards: number;
  overdue: number;
  dueToday: number;
  /** Pre-formatted footer text, left and right. */
  footerLeft: string;
  footerRight: string;
  tasks: { id: string; title: string; overdue: boolean }[];
  /** Deep link opened when the widget is tapped. */
  url: string;
}

export interface ProgressWidgetProps {
  /** OS text-size multiplier (the widget runtime does not inherit Dynamic Type). */
  fontScale: number;
  /** Keyed by the Project picker value; "workspace" is the whole-workspace card. */
  cards: Record<string, WidgetCard>;
  light: WidgetColors;
  dark: WidgetColors;
}

/** Value of the picker entry that means "the whole workspace". */
export const WORKSPACE_KEY = "workspace";

/**
 * Progress widget — mirrors the Overview's progress card (label, big %, ring,
 * meter, footer) plus the day's tasks. Runs in WidgetKit's isolated JS runtime,
 * so it is fully self-contained: no module-level values, no imports at use
 * sites — everything (including theme colours) arrives via props.
 * Marked with the `'widget'` directive so expo-widgets bundles it separately.
 */
function ProgressWidget(props: ProgressWidgetProps, env: WidgetEnvironment<{ project?: string } | undefined>) {
  "widget";
  const c = env.colorScheme === "dark" ? props.dark : props.light;
  const key = env.configuration?.project ?? "workspace";
  const k = props.fontScale ?? 1;
  const card = props.cards[key];
  if (!card) {
    // A configured project that was deleted (or hasn't synced) must not masquerade as workspace progress.
    const gone = key !== "workspace";
    return (
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[frame({ maxWidth: 10000, maxHeight: 10000, alignment: "topLeading" }), containerBackground(c.surface, "widget"), widgetURL("cairn://projects")]}
      >
        <Text modifiers={[font({ size: 13 * k, weight: "semibold" }), foregroundStyle(c.textPrimary)]}>{gone ? "Project unavailable" : "Cairn"}</Text>
        <Text modifiers={[font({ size: 11 * k }), foregroundStyle(c.textTertiary)]}>
          {gone ? "It may have been deleted. Long-press the widget and choose Edit Widget to pick another." : "Open Cairn to load your progress."}
        </Text>
      </VStack>
    );
  }
  const attention = card.overdue + card.dueToday;
  const labelColor = attention > 0 ? c.warning : c.textTertiary;
  const small = env.widgetFamily === "systemSmall";
  const tasks = card.tasks.slice(0, env.widgetFamily === "systemLarge" ? 7 : 2);

  return (
    <VStack
      alignment="leading"
      spacing={8}
      modifiers={[frame({ maxWidth: 10000, maxHeight: 10000, alignment: "topLeading" }), containerBackground(c.surface, "widget"), widgetURL(card.url)]}
    >
      <HStack alignment="center" spacing={8}>
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 10 * k, weight: "semibold" }), foregroundStyle(labelColor), lineLimit(1)]}>
            {small ? card.title.toUpperCase() : `${card.title.toUpperCase()} · ${attention > 0 ? "NEEDS ATTENTION" : "ON TRACK"}`}
          </Text>
          <HStack alignment="firstTextBaseline" spacing={2}>
            <Text modifiers={[font({ size: (small ? 34 : 30) * k, weight: "bold", design: "rounded" }), foregroundStyle(c.textPrimary)]}>
              {String(card.completion)}
            </Text>
            <Text modifiers={[font({ size: 12 * k }), foregroundStyle(c.textTertiary)]}>%</Text>
          </HStack>
          <Text modifiers={[font({ size: 11 * k }), foregroundStyle(c.textTertiary), lineLimit(1)]}>
            {small ? `${card.doneCards}/${card.totalCards} done` : `${card.doneCards} / ${card.totalCards} done · ${card.openCards} open`}
          </Text>
        </VStack>
        <Spacer />
        {small ? null : (
          <Gauge
            value={card.completion / 100}
            currentValueLabel={<Text modifiers={[font({ size: 11 * k, weight: "semibold" }), foregroundStyle(c.textPrimary)]}>{`${card.completion}%`}</Text>}
            modifiers={[gaugeStyle("circularCapacity"), tint(c.accent), frame({ width: 56, height: 56 })]}
          >
            <Text>Done</Text>
          </Gauge>
        )}
      </HStack>
      <Gauge value={card.completion / 100} modifiers={[gaugeStyle("linearCapacity"), tint(c.accent)]}>
        <Text>Progress</Text>
      </Gauge>
      {small || tasks.length === 0 ? null : (
        <VStack alignment="leading" spacing={3}>
          {tasks.map((t) => (
            <Text key={t.id} modifiers={[font({ size: 12 * k }), foregroundStyle(t.overdue ? c.danger : c.textPrimary), lineLimit(1)]}>
              {`• ${t.title}`}
            </Text>
          ))}
        </VStack>
      )}
      <Spacer />
      <HStack>
        {small ? null : <Text modifiers={[font({ size: 10 * k }), foregroundStyle(c.textTertiary), lineLimit(1)]}>{card.footerLeft}</Text>}
        {small ? null : <Spacer />}
        <Text modifiers={[font({ size: 10 * k, weight: attention > 0 ? "semibold" : "regular" }), foregroundStyle(labelColor), lineLimit(1)]}>
          {card.footerRight}
        </Text>
      </HStack>
    </VStack>
  );
}

const LIGHT: WidgetColors = {
  surface: "#ffffff",
  accent: "#5c7a3f",
  textPrimary: "#1a1917",
  textTertiary: "#9e9a94",
  warning: "#d97706",
  danger: "#dc2626",
};
const DARK: WidgetColors = {
  surface: "#141414",
  accent: "#8faf6f",
  textPrimary: "#e8e4dc",
  textTertiary: "#66635f",
  warning: "#f59e0b",
  danger: "#ef4444",
};
const INITIAL: ProgressWidgetProps = { cards: {}, fontScale: 1, light: LIGHT, dark: DARK };

/** Whole-workspace card — no picker. */
export const workspaceWidget = createWidget<ProgressWidgetProps>("CairnWorkspace", ProgressWidget, INITIAL);

/** Per-project card — `project` parameter picks the project (options are filled in at runtime). */
export const projectWidget = createWidget<ProgressWidgetProps, { project: string }>("CairnProject", ProgressWidget, INITIAL);
