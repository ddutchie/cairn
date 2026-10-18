import { Gauge, HStack, ProgressView, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  frame,
  gaugeStyle,
  listRowSeparator,
  padding,
  progressViewStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { getDueDateStatus } from "@cairn/shared/format/date";
import type { WorkspaceProgress } from "@/db/queries";
import { useTheme } from "@/theme";

/**
 * Workspace-wide progress header pinned above the projects list — the overall
 * counterpart to the per-project Overview instrument (same done-definition:
 * done-column cards / all cards, aggregated across every project).
 *
 * Native SwiftUI (not an RNHostView): a hosted RN card measured itself to its
 * intrinsic content width and left an empty gutter on the right; native stacks
 * fill the column like the project rows do. Shows the % with counts, a ring
 * gauge, a linear bar, and a project/note/overdue footer.
 */
export function WorkspaceProgressHeader({ progress }: { progress: WorkspaceProgress }) {
  const t = useTheme();

  let overdue = 0;
  let today = 0;
  for (const d of progress.openDueDates) {
    const s = getDueDateStatus(d);
    if (s === "overdue") overdue += 1;
    else if (s === "today") today += 1;
  }
  const needsAttention = overdue + today;
  const secondary = { type: "hierarchical", style: "secondary" } as const;

  return (
    <Section modifiers={[listRowSeparator("hidden")]}>
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[padding({ vertical: 6 }), frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        <Text
          modifiers={[
            font({ textStyle: "caption", weight: "semibold" }),
            foregroundStyle(needsAttention > 0 ? t.warning : t.textTertiary),
          ]}
        >
          {`WORKSPACE PROGRESS · ${needsAttention > 0 ? "NEEDS ATTENTION" : "ON TRACK"}`}
        </Text>
        <HStack spacing={12} modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}>
          <VStack alignment="leading" spacing={2}>
            <HStack spacing={4} alignment="lastTextBaseline">
              <Text modifiers={[font({ textStyle: "largeTitle", weight: "bold" }), foregroundStyle(t.textPrimary)]}>
                {`${progress.completionRate}`}
              </Text>
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(secondary)]}>%</Text>
            </HStack>
            <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(secondary)]}>
              {`${progress.doneCards} / ${progress.totalCards} done · ${progress.openCards} open`}
            </Text>
          </VStack>
          <Spacer />
          <Gauge
            value={progress.doneCards}
            min={0}
            max={Math.max(1, progress.totalCards)}
            currentValueLabel={
              <Text modifiers={[font({ textStyle: "caption", weight: "semibold" }), foregroundStyle(t.textPrimary)]}>
                {`${progress.completionRate}%`}
              </Text>
            }
            modifiers={[gaugeStyle("circularCapacity"), tint(t.accent), frame({ width: 60, height: 60 })]}
          />
        </HStack>
        <ProgressView value={progress.totalCards > 0 ? progress.doneCards / progress.totalCards : 0} modifiers={[progressViewStyle("linear"), tint(t.accent)]} />
        <HStack modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}>
          <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(secondary)]}>
            {`${progress.projectCount} ${progress.projectCount === 1 ? "project" : "projects"} · ${progress.totalNotes} ${progress.totalNotes === 1 ? "note" : "notes"}`}
          </Text>
          <Spacer />
          <Text
            modifiers={[
              font({ textStyle: "footnote", weight: needsAttention > 0 ? "semibold" : "regular" }),
              foregroundStyle(needsAttention > 0 ? t.warning : secondary),
            ]}
          >
            {progress.totalCards === 0 ? "No tasks yet" : needsAttention > 0 ? `${overdue} overdue · ${today} today` : "All caught up"}
          </Text>
        </HStack>
      </VStack>
    </Section>
  );
}
