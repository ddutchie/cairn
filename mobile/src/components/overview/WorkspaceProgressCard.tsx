import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { getDueDateStatus } from "@cairn/shared/format/date";
import type { WorkspaceProgress } from "@/db/queries";
import { useTheme, type as typeScale } from "@/theme";
import { ProgressRing } from "./ProgressRing";

/**
 * Workspace-wide progress header — the "overall progress" companion to the
 * per-project Overview instrument. Same done-definition (done-column cards /
 * all cards) aggregated across every project, same ring + meter language, but
 * workspace-scoped: project/note counts and an overdue line replace the
 * per-project start/target dates (which have no workspace meaning).
 *
 * Sized for the projects sidebar column (~300pt) and reused as the narrow
 * list's header on Android.
 */
export function WorkspaceProgressCard({ progress }: { progress: WorkspaceProgress }) {
  const t = useTheme();
  const { overdue, today } = useMemo(() => {
    let overdue = 0;
    let today = 0;
    for (const d of progress.openDueDates) {
      const s = getDueDateStatus(d);
      if (s === "overdue") overdue += 1;
      else if (s === "today") today += 1;
    }
    return { overdue, today };
  }, [progress.openDueDates]);

  const needsAttention = overdue + today;
  const label = needsAttention > 0 ? "Workspace progress · needs attention" : "Workspace progress · on track";
  const labelColor = needsAttention > 0 ? t.warning : t.textTertiary;

  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
      <Text style={[typeScale.micro, { color: labelColor, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" }]}>
        {label}
      </Text>
      <View style={styles.main}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
            <Text style={[typeScale.display, { color: t.textPrimary }]}>{progress.completionRate}</Text>
            <Text style={[typeScale.caption, { color: t.textTertiary }]}>%</Text>
          </View>
          <Text style={[typeScale.caption, { color: t.textTertiary, marginTop: 2 }]} numberOfLines={2}>
            <Text style={{ color: t.textPrimary, fontWeight: "600", fontFamily: "Menlo" }}>
              {progress.doneCards} / {progress.totalCards}
            </Text>{" "}
            done · {progress.openCards} open
          </Text>
        </View>
        <ProgressRing percent={progress.completionRate} size={64} stroke={5} variant="instrument" />
      </View>
      <View style={[styles.meterTrack, { backgroundColor: t.surface3 }]}>
        <View style={[styles.meterFill, { width: `${progress.completionRate}%`, backgroundColor: t.accent }]} />
      </View>
      <View style={styles.footer}>
        <Text style={[typeScale.micro, { color: t.textTertiary }]} numberOfLines={1}>
          {progress.projectCount} {progress.projectCount === 1 ? "project" : "projects"} · {progress.totalNotes}{" "}
          {progress.totalNotes === 1 ? "note" : "notes"}
        </Text>
        <Text style={[typeScale.micro, { color: needsAttention > 0 ? t.warning : t.textTertiary, fontWeight: needsAttention > 0 ? "600" : "400" }]} numberOfLines={1}>
          {progress.totalCards === 0 ? "No tasks yet" : needsAttention > 0 ? `${overdue} overdue · ${today} today` : "All caught up"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 10 },
  main: { flexDirection: "row", alignItems: "center", gap: 12 },
  meterTrack: { height: 6, borderRadius: 3, overflow: "hidden", flexDirection: "row", alignItems: "center" },
  meterFill: { height: "100%", borderRadius: 3 },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
});
