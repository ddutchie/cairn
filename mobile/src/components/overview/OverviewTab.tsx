import { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, RefreshControl, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { FileText, Circle as CircleIcon, Pin, StickyNote, ListTodo, AlertTriangle, Clock3, Folder, FolderCode, Activity, LayoutDashboard, Kanban } from "lucide-react-native";
import { computeProjectMetrics } from "@cairn/shared/overview/metrics";
import { COLUMN_COLORS, PRIORITY_COLOR, COLUMN_TYPE_ORDER } from "@cairn/shared/ui/constants";
import { getDueDateStatus, formatRelative, parseIsoLocal, formatDate } from "@cairn/shared/format/date";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { type ProjectOverviewData } from "@/db/queries";
import { ProjectIcon } from "@/components/ProjectIcon";
import { PressableScale } from "@/components/PressableScale";
import { EmptyState } from "@/components/EmptyState";
import { ProgressRing } from "./ProgressRing";
import { HealthRadar, buildRadarAxes } from "./HealthRadar";
import { celebrateProjectMilestone } from "@/gamification/rewards";
import { useTheme, withAlpha, elevation, type as typeScale, type Theme } from "@/theme";

type FocusFilter = "all" | "today" | "overdue" | "pinned";

function statusColor(t: Theme, status: string): string {
  switch (status) {
    case "active":
      return t.success;
    case "on_hold":
      return t.warning;
    case "completed":
      return t.info;
    default:
      return t.textTertiary;
  }
}

function prettyStatus(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface OverviewNav {
  onOpenNote: (id: string) => void;
  onOpenCard: (id: string) => void;
  onViewNotes: () => void;
  onViewBoard: () => void;
}

/**
 * Per-project Overview — RN counterpart of desktop ProjectOverview (Instrument redesign).
 * All numbers come from shared computeProjectMetrics() so desktop and mobile agree.
 * Honest: completion %, due filtering, bottleneck, WIP, dates all derived live.
 */
export function OverviewTab({
  data,
  nav,
  bottomPad,
  onRefresh,
  refreshing,
}: {
  data: ProjectOverviewData;
  nav: OverviewNav;
  bottomPad: number;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [focus, setFocus] = useState<FocusFilter>("all");

  const metrics = useMemo(
    () =>
      computeProjectMetrics({
        columns: data.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        cards: data.cards.map((c) => ({
          id: c.id,
          columnId: c.column_id,
          title: c.title,
          priority: c.priority,
          dueDate: c.due_date ?? null,
          updatedAt: c.updated_at,
        })),
        notes: data.notes.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
          isPinned: !!n.is_pinned,
          updatedAt: n.updated_at,
          tagIds: [],
        })),
      }),
    [data],
  );

  const noteById = useMemo(() => new Map(data.notes.map((n) => [n.id, n])), [data.notes]);

  const project = data.project;
  const { completionRate, doneCards, allCards, openCards, overdueCount, priorityCounts, columns: metricColumns, dueCards, pinnedNotes, recentNotes, activityByDay, totalNotes } = metrics;

  // ---- derived headline insights (mirrors desktop) ----
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const todayCount = useMemo(() => dueCards.filter((c) => getDueDateStatus(c.dueDate) === "today").length, [dueCards]);
  const needsAttention = overdueCount + todayCount;

  const bottleneck = useMemo<{ name: string; count: number } | null>(() => {
    const doneColId = metricColumns.find((c) => c.type === "done")?.id;
    const openCols = metricColumns.filter((c) => c.id !== doneColId);
    let best: { name: string; count: number } | null = null;
    let max = -1;
    for (const col of openCols) {
      const count = allCards.filter((c) => c.columnId === col.id).length;
      if (count > max) {
        max = count;
        best = { name: col.name, count };
      }
    }
    return best && best.count > 0 ? best : null;
  }, [metricColumns, allCards]);

  const overdueCards = useMemo(() => dueCards.filter((c) => getDueDateStatus(c.dueDate) === "overdue"), [dueCards]);
  const todayCards = useMemo(() => dueCards.filter((c) => getDueDateStatus(c.dueDate) === "today"), [dueCards]);
  const upcomingCards = useMemo(
    () =>
      dueCards.filter((c) => {
        const s = getDueDateStatus(c.dueDate);
        return s !== "overdue" && s !== "today";
      }),
    [dueCards],
  );

  const attentionQueue = useMemo<{ card: (typeof dueCards)[number]; label: string; tone: "overdue" | "today" | "upcoming" }[]>(() => {
    const q: { card: (typeof dueCards)[number]; label: string; tone: "overdue" | "today" | "upcoming" }[] = [];
    if (overdueCards[0]) {
      const d = parseIsoLocal(overdueCards[0].dueDate!);
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      q.push({ card: overdueCards[0], label: `Overdue · ${Math.abs(days)}d`, tone: "overdue" });
    }
    if (todayCards[0] && q.length < 3) {
      q.push({ card: todayCards[0], label: "Due today", tone: "today" });
    }
    if (upcomingCards[0] && q.length < 3) {
      const d = parseIsoLocal(upcomingCards[0].dueDate!);
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      q.push({ card: upcomingCards[0], label: `Up next · in ${days}d`, tone: "upcoming" });
    }
    if (q.length < 3 && overdueCards[1]) {
      const d = parseIsoLocal(overdueCards[1].dueDate!);
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      q.push({ card: overdueCards[1], label: `Overdue · ${Math.abs(days)}d`, tone: "overdue" });
    }
    return q;
  }, [overdueCards, todayCards, upcomingCards, today]);

  const focusCounts = useMemo<Record<FocusFilter, number>>(
    () => ({
      all: openCards.length,
      today: todayCount,
      overdue: overdueCount,
      pinned: pinnedNotes.length,
    }),
    [openCards.length, todayCount, overdueCount, pinnedNotes.length],
  );

  const filteredQueue = useMemo(() => {
    if (focus === "all") return attentionQueue;
    if (focus === "overdue") return attentionQueue.filter((q) => q.tone === "overdue");
    if (focus === "today") return attentionQueue.filter((q) => q.tone === "today");
    return [];
  }, [attentionQueue, focus]);

  const filteredCards = useMemo(() => {
    if (focus === "overdue") return overdueCards;
    if (focus === "today") return todayCards;
    return openCards;
  }, [focus, openCards, overdueCards, todayCards]);

  const filteredPriorityCounts = useMemo(() => {
    const cards = filteredCards;
    return {
      urgent: cards.filter((c) => c.priority === "urgent").length,
      high: cards.filter((c) => c.priority === "high").length,
      medium: cards.filter((c) => c.priority === "medium").length,
      low: cards.filter((c) => c.priority === "low").length,
    };
  }, [filteredCards]);

  const inProgressCol = useMemo(() => metricColumns.find((c) => c.type === "in_progress") ?? data.columns.find((c) => c.type === "in_progress"), [metricColumns, data.columns]);
  const inProgressCount = inProgressCol ? allCards.filter((c) => c.columnId === inProgressCol.id).length : 0;
  // card_limit is nullable number from OverviewColumn
  const wipLimit = (inProgressCol as unknown as { card_limit?: number | null })?.card_limit ?? null;
  const wipStatus = wipLimit ? (inProgressCount > wipLimit ? "over" : inProgressCount === wipLimit ? "at limit" : "healthy") : null;

  const progressLabel = needsAttention > 0 ? "Progress · needs attention" : "Progress · on track";
  const instrumentPct = completionRate;
  const instrumentDone = doneCards.length;
  const instrumentTotal = allCards.length;
  const doneColId = useMemo(() => metricColumns.find((c) => c.type === "done")?.id ?? data.columns.find((c) => c.type === "done")?.id, [metricColumns, data.columns]);
  const flowColumns = useMemo(() => {
    const cols = [...metricColumns];
    const order = COLUMN_TYPE_ORDER as string[];
    return cols.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  }, [metricColumns]);

  const radarAxes = useMemo(
    () =>
      buildRadarAxes({
        completionRate,
        openCards,
        overdueCount,
        todayCount,
        notes: { length: totalNotes },
        pinnedNotes,
        recentNotes,
        bottleneck,
        priorityCounts,
        columns: metricColumns as unknown as { id: string; type: string }[],
        allCards,
        activityByDay: activityByDay as unknown as { items: unknown[] }[],
      }),
    [completionRate, openCards, overdueCount, todayCount, totalNotes, pinnedNotes, recentNotes, bottleneck, priorityCounts, metricColumns, allCards, activityByDay],
  );

  const empty = data.notes.length === 0 && allCards.length === 0;

  useEffect(() => {
    if (project) celebrateProjectMilestone(project.id, completionRate, allCards.length);
  }, [project, completionRate, allCards.length]);

  const focusLabel: Record<FocusFilter, string> = { all: "All", today: "Due today", overdue: "Overdue", pinned: "Pinned" };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
      showsVerticalScrollIndicator={false}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.textTertiary} /> : undefined}
    >
      {/* ── masthead + instrument ── */}
      {project ? (
        <View style={styles.masthead}>
          <View style={styles.mastheadLeft}>
            <View style={[styles.headerIcon, { backgroundColor: t.surface2, borderColor: t.border }]}>
              <ProjectIcon name={project.icon} size={22} color={t.textSecondary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[typeScale.subtitle, { color: t.textPrimary, fontWeight: "700" }]} numberOfLines={2}>
                {project.name}
                <Text style={{ fontWeight: "400", fontStyle: "italic", color: t.accent }}>
                  {bottleneck ? ` — ${bottleneck.name.toLowerCase()} holds ${bottleneck.count}` : ` — ${instrumentPct}% complete`}
                </Text>
              </Text>
              {(() => {
                if (project.description?.trim()) {
                  return (
                    <Text style={[typeScale.caption, { color: t.textSecondary, marginTop: 4, lineHeight: 18 }]} numberOfLines={3}>
                      {project.description}
                    </Text>
                  );
                }
                const recent = activityByDay[0]?.items[0];
                const ctxLine = (() => {
                  if (needsAttention > 0) return `${needsAttention} needing attention · ${bottleneck ? `${bottleneck.count} in ${bottleneck.name}` : `${openCards.length} open`} · ${totalNotes} notes`;
                  if (bottleneck) return `${bottleneck.name} is the bottleneck — ${bottleneck.count} of ${openCards.length} open · ${totalNotes} notes · ${pinnedNotes.length} pinned`;
                  if (totalNotes) return `${totalNotes} notes · ${recent ? `last edit ${formatRelative(recent.updatedAt)}` : "no recent activity"}`;
                  return "Add notes and tasks to see your project context here";
                })();
                return <Text style={[typeScale.caption, { color: t.textSecondary, marginTop: 4, lineHeight: 18 }]}>{ctxLine}</Text>;
              })()}
              <View style={styles.pillRow}>
                <Pill label={prettyStatus(project.status)} color={statusColor(t, project.status)} t={t} />
                {project.priority ? <Pill label={prettyStatus(project.priority)} color={PRIORITY_COLOR[project.priority] ?? t.textTertiary} t={t} /> : null}
                {project.due_date ? (
                  <View style={[styles.miniPill, { backgroundColor: t.surface2, borderColor: t.border }]}>
                    <Text style={[typeScale.micro, { color: t.textTertiary }]}>{formatDate(project.due_date)}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.codeRow}>
                {project.code_directory ? (
                  <View style={[styles.codePill, { backgroundColor: t.surface, borderColor: t.border }]}>
                    <FolderCode size={12} color={t.accent} />
                    <Text style={[typeScale.micro, { color: t.textSecondary }]} numberOfLines={1}>
                      {(project.code_directory.split("/").pop() || "Code").slice(0, 18)}
                    </Text>
                    <View style={[styles.codeDot, { backgroundColor: t.success }]} />
                  </View>
                ) : (
                  <View style={[styles.codePillDashed, { borderColor: t.border }]}>
                    <Folder size={12} color={t.textTertiary} />
                    <Text style={[typeScale.micro, { color: t.textTertiary }]}>No code folder</Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* instrument — true radial gradient like desktop: 520×180 at 85% -10%, 14% → transparent 60% */}
          <View style={[styles.instrument, { backgroundColor: t.surface, borderColor: t.border, overflow: "hidden" } as StyleProp<ViewStyle>, elevation.md as StyleProp<ViewStyle>]}>
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 14, overflow: "hidden" }]}>
              <Svg width="100%" height="100%" viewBox="0 0 360 200" preserveAspectRatio="none">
                <Defs>
                  <RadialGradient id="instGrad" cx="85%" cy="-10%" rx="72%" ry="90%" gradientUnits="objectBoundingBox">
                    <Stop offset="0%" stopColor={t.accent} stopOpacity={0.14} />
                    <Stop offset="60%" stopColor={t.accent} stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Rect x={0} y={0} width={360} height={200} fill="url(#instGrad)" />
              </Svg>
            </View>
            <View style={styles.instrumentHead}>
              <Text style={[typeScale.micro, { color: needsAttention > 0 ? t.warning : t.textTertiary, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" }]}>{progressLabel}</Text>
            </View>
            <View style={styles.instrumentMain}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
                  <Text style={[typeScale.display, { color: t.textPrimary }]}>{instrumentPct}</Text>
                  <Text style={[typeScale.caption, { color: t.textTertiary }]}>%</Text>
                </View>
                <Text style={[typeScale.caption, { color: t.textTertiary, marginTop: 2 }]}>
                  <Text style={{ color: t.textPrimary, fontWeight: "600", fontFamily: "Menlo" }}>{instrumentDone} / {instrumentTotal}</Text> done · {openCards.length} open · {doneCards.length} done
                </Text>
              </View>
              <ProgressRing percent={instrumentPct} size={74} stroke={5} variant="instrument" />
            </View>
            <View style={[styles.meterTrack, { backgroundColor: t.surface3 }]}>
              <View style={[styles.meterFill, { width: `${instrumentPct}%`, backgroundColor: t.accent }]} />
              <View style={styles.meterTicks} pointerEvents="none">
                {Array.from({ length: 8 }).map((_, i) => (
                  <View key={i} style={[styles.meterTick, { backgroundColor: t.borderSubtle }]} />
                ))}
              </View>
            </View>
            <View style={styles.instrumentDates}>
              <Text style={[typeScale.micro, { color: t.textTertiary }]}>
                Started <Text style={{ color: t.textPrimary, fontWeight: "600" }}>{project.created_at ? formatDate(project.created_at) : "—"}</Text>
              </Text>
              <Text style={[typeScale.micro, { color: t.textTertiary }]}>
                {project.due_date ? (
                  <>
                    Target <Text style={{ color: t.textPrimary, fontWeight: "600" }}>{formatDate(project.due_date)}</Text>
                  </>
                ) : (
                  "No target date"
                )}
              </Text>
            </View>
            <Pressable onPress={nav.onViewBoard} style={[styles.viewBoardBtn, { backgroundColor: t.surface2, borderColor: t.border }]}>
              <Text style={[typeScale.caption, { color: t.textSecondary, fontWeight: "600" }]}>View board →</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* ── focus bar ── */}
      <View style={[styles.focusBar, { backgroundColor: t.surface, borderColor: t.border }, elevation.sm as StyleProp<ViewStyle>]}>
        <Text style={[typeScale.micro, { color: t.textTertiary, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", marginRight: 4 }]}>Focus</Text>
        {(["all", "today", "overdue", "pinned"] as FocusFilter[]).map((k) => {
          const label =
            k === "all" ? `All · ${focusCounts.all} open` : k === "today" ? `Due today · ${focusCounts.today}` : k === "overdue" ? `Overdue · ${focusCounts.overdue}` : `Pinned · ${focusCounts.pinned}`;
          const active = focus === k;
          return (
            <Pressable
              key={k}
              onPress={() => setFocus(k)}
              style={[
                styles.focusPill,
                {
                  backgroundColor: active ? t.textPrimary : t.surface2,
                  borderColor: active ? t.textPrimary : t.border,
                },
              ]}
            >
              <Text style={[typeScale.caption, { color: active ? t.background : t.textSecondary, fontWeight: active ? "700" : "500", fontSize: 12 }]}>{label}</Text>
            </Pressable>
          );
        })}
        <View style={{ flex: 1 }} />
        <Text style={[typeScale.micro, { color: t.textTertiary, fontFamily: "Menlo" }]}>{focus === "all" ? "Showing all" : `Filtered: ${focusLabel[focus]}`} · {filteredQueue.length || focusCounts[focus]} items</Text>
      </View>

      {/* ── KPI strip — hairline dividers, not double borders ── */}
      <View style={[styles.kpiStrip, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={[styles.kpiCell, { borderColor: t.border, borderRightWidth: 1, borderBottomWidth: 1 }]}>
          <View style={[styles.kpiAccent, { backgroundColor: t.danger }]} />
          <Text style={[typeScale.micro, styles.kpiLabel, { color: t.textTertiary }]}>Needs attention</Text>
          <View style={styles.kpiValueRow}>
            <Text style={[typeScale.heading, { color: t.textPrimary }]}>{needsAttention}</Text>
            <Text style={[typeScale.caption, { color: t.textTertiary }]}>/ {openCards.length}</Text>
          </View>
          <Text style={[typeScale.caption, { color: needsAttention > 0 ? t.danger : t.success, fontWeight: "600", marginTop: 4, fontSize: 11 }]} numberOfLines={1}>
            {needsAttention > 0 ? `${overdueCount} overdue · ${todayCount} today` : "All caught up"}
          </Text>
        </View>
        <View style={[styles.kpiCell, { borderColor: t.border, borderBottomWidth: 1 }]}>
          <View style={[styles.kpiAccent, { backgroundColor: t.success }]} />
          <Text style={[typeScale.micro, styles.kpiLabel, { color: t.textTertiary }]}>Completion</Text>
          <View style={styles.kpiValueRow}>
            <Text style={[typeScale.heading, { color: t.textPrimary }]}>{instrumentPct}%</Text>
            <Text style={[typeScale.caption, { color: t.textTertiary }]}>{instrumentDone}/{instrumentTotal}</Text>
          </View>
          <Text style={[typeScale.caption, { color: t.textTertiary, marginTop: 4, fontSize: 11 }]} numberOfLines={1}>
            {instrumentTotal > 0 ? `${instrumentDone} done · ${openCards.length} open` : "No tasks yet"}
          </Text>
        </View>
        <View style={[styles.kpiCell, styles.kpiCellTint, { backgroundColor: withAlpha(t.surface2, 0.6), borderColor: t.border, borderRightWidth: 1 }]}>
          <View style={[styles.kpiAccent, { backgroundColor: t.info }]} />
          <Text style={[typeScale.micro, styles.kpiLabel, { color: t.textTertiary }]}>Knowledge</Text>
          <View style={styles.kpiValueRow}>
            <Text style={[typeScale.heading, { color: t.textPrimary }]}>{totalNotes}</Text>
            <Text style={[typeScale.caption, { color: t.textTertiary }]}>notes</Text>
          </View>
          <Text style={[typeScale.caption, { color: t.textTertiary, marginTop: 4, fontSize: 11 }]} numberOfLines={1}>
            {pinnedNotes.length} pinned{totalNotes > 0 && recentNotes[0] ? ` · ${formatRelative(recentNotes[0].updatedAt)}` : ""}
          </Text>
        </View>
        <View style={[styles.kpiCell, styles.kpiCellTint, { backgroundColor: withAlpha(t.surface2, 0.6), borderColor: t.border }]}>
          <View style={[styles.kpiAccent, { backgroundColor: t.warning }]} />
          <Text style={[typeScale.micro, styles.kpiLabel, { color: t.textTertiary }]}>Bottleneck</Text>
          <View style={styles.kpiValueRow}>
            <Text style={[typeScale.heading, { color: t.textPrimary }]}>{bottleneck ? bottleneck.count : "—"}</Text>
            <Text style={[typeScale.caption, { color: t.textTertiary }]}>{bottleneck ? `in ${bottleneck.name}` : "—"}</Text>
          </View>
          <Text style={[typeScale.caption, { color: t.textTertiary, marginTop: 4, fontSize: 11 }]} numberOfLines={1}>
            {bottleneck ? `${openCards.length} open total` : "Add columns"}
          </Text>
        </View>
      </View>

      {/* ── attention queue ── */}
      <View style={{ gap: 8 }}>
        {filteredQueue.length === 0 ? (
          <View style={[styles.emptyQueue, { backgroundColor: withAlpha(t.surface2, 0.6), borderColor: t.border }]}>
            <View style={[styles.emptyIcon, { backgroundColor: withAlpha(t.success, 0.15), borderColor: withAlpha(t.success, 0.2) }]}>
              <Kanban size={14} color={t.success} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[typeScale.control, { color: t.textPrimary, fontWeight: "600" }]}>
                {focus === "overdue" ? "No overdue tasks" : focus === "today" ? "Nothing due today" : focus === "pinned" ? `${pinnedNotes.length} pinned notes — see below` : "All caught up"}
              </Text>
              <Text style={[typeScale.caption, { color: t.textTertiary, fontSize: 12 }]}>
                {focus === "all" && openCards.length > 0 ? `${openCards.length} open · ${bottleneck ? `${bottleneck.count} in ${bottleneck.name}` : "no bottleneck"}` : focus === "pinned" ? "Scroll to Pinned keeps focus" : "No action needed — nice."}
              </Text>
            </View>
            <Pressable onPress={() => (focus === "pinned" ? nav.onViewNotes() : nav.onViewBoard())} style={[styles.emptyAction, { borderColor: t.border, backgroundColor: t.surface }]}>
              <Text style={[typeScale.caption, { color: t.textSecondary, fontWeight: "600", fontSize: 12 }]}>{focus === "pinned" ? "Open notes →" : "View board →"}</Text>
            </Pressable>
          </View>
        ) : (
          filteredQueue.map(({ card, label, tone }) => {
            const col = metricColumns.find((c) => c.id === card.columnId) ?? data.columns.find((c) => c.id === card.columnId);
            const prioColor = (PRIORITY_COLOR as Record<string, string>)[card.priority] ?? t.textTertiary;
            return (
              <Pressable
                key={card.id}
                onPress={() => nav.onOpenCard(card.id)}
                style={[
                  styles.queueCard,
                  {
                    backgroundColor: tone === "overdue" ? withAlpha(t.danger, 0.07) : tone === "today" ? withAlpha(t.warning, 0.07) : t.surface,
                    borderColor: tone === "overdue" ? withAlpha(t.danger, 0.25) : tone === "today" ? withAlpha(t.warning, 0.25) : t.border,
                  },
                ]}
              >
                <View
                  style={[
                    styles.queueIcon,
                    {
                      backgroundColor: tone === "overdue" ? withAlpha(t.danger, 0.14) : tone === "today" ? withAlpha(t.warning, 0.14) : t.accentDim,
                      borderColor: tone === "overdue" ? withAlpha(t.danger, 0.18) : tone === "today" ? withAlpha(t.warning, 0.18) : withAlpha(t.accent, 0.18),
                    },
                  ]}
                >
                  {tone === "overdue" ? <AlertTriangle size={14} color={tone === "overdue" ? t.danger : tone === "today" ? t.warning : t.accent} /> : tone === "today" ? <Clock3 size={14} color={t.warning} /> : <StickyNote size={12} color={t.accent} />}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[typeScale.micro, { color: tone === "overdue" ? t.danger : tone === "today" ? t.warning : t.textTertiary, fontWeight: "700", letterSpacing: 0.3, textTransform: "uppercase", fontSize: 10 }]}>{label}</Text>
                  <Text style={[typeScale.control, { color: t.textPrimary, fontWeight: "600" }]} numberOfLines={1}>
                    {card.title}
                  </Text>
                  <Text style={[typeScale.micro, { color: t.textTertiary }]} numberOfLines={1}>
                    {col?.name ?? "—"} · {card.priority} priority
                  </Text>
                </View>
                <Text style={[typeScale.micro, { color: t.textSecondary, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface2 }]}>Open →</Text>
                <View style={[styles.queueStripe, { backgroundColor: prioColor }]} />
              </Pressable>
            );
          })
        )}
      </View>

      {/* ── task flow + priority bento ── */}
      <View style={[styles.bentoCard, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.bentoHeader}>
          <View style={[styles.bentoIcon, { backgroundColor: t.surface2, borderColor: t.border }]}>
            <Text style={{ fontSize: 10, color: t.textTertiary }}>▦</Text>
          </View>
          <Text style={[typeScale.caption, { color: t.textPrimary, fontWeight: "600" }]}>Task flow</Text>
          <Text style={[typeScale.micro, { color: t.textTertiary }]}> — {bottleneck ? `${bottleneck.name} is the bottleneck (${bottleneck.count} of ${openCards.length} open)` : `${openCards.length} open`}</Text>
        </View>
        {flowColumns.length === 0 ? (
          <Text style={[typeScale.caption, { color: t.textTertiary, textAlign: "center", paddingVertical: 12 }]}>No columns yet</Text>
        ) : (
          <View style={{ gap: 0 }}>
            {flowColumns.map((col, idx) => {
              const sourceCards = focus === "overdue" || focus === "today" ? filteredCards : allCards;
              const sourceOpen = focus === "overdue" || focus === "today" ? filteredCards : openCards;
              const count = sourceCards.filter((c) => c.columnId === col.id).length;
              const isOpen = col.id !== doneColId;
              const denom = isOpen ? sourceOpen.length || 1 : sourceCards.length || 1;
              const pct = Math.round((count / denom) * 100);
              const color = (COLUMN_COLORS as Record<string, string>)[col.type] ?? COLUMN_COLORS.custom;
              const isBottleneck = bottleneck?.name === col.name && focus === "all";
              const hasFiltered = focus !== "all" && count === 0 && focus !== "pinned";
              return (
                <View key={col.id} style={[styles.barRow, idx !== 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }, hasFiltered && { opacity: 0.4 }]}>
                  <Text style={[typeScale.caption, styles.barLabel, { color: t.textSecondary }]} numberOfLines={1}>
                    {col.name}
                  </Text>
                  <View style={[styles.barTrack, { backgroundColor: t.surface2, borderColor: isBottleneck ? withAlpha(t.warning, 0.5) : t.border }, isBottleneck && { borderWidth: 1, shadowColor: t.warning, shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }]}>
                    <View style={{ width: `${Math.max(pct, count > 0 ? 8 : 0)}%`, height: "100%", borderRadius: 10, backgroundColor: color }} />
                  </View>
                  <Text style={[typeScale.caption, styles.barCount, { color: t.textTertiary, fontFamily: "Menlo" }]}>{count}</Text>
                </View>
              );
            })}
          </View>
        )}
        <View style={styles.legendRow}>
          {(["backlog", "todo", "in_progress", "review", "done"] as const).map((k) => (
            <View key={k} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: (COLUMN_COLORS as Record<string, string>)[k] }]} />
              <Text style={[typeScale.micro, { color: t.textTertiary, fontSize: 10 }]}>{k === "in_progress" ? "In Progress" : k.charAt(0).toUpperCase() + k.slice(1)}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={[styles.bentoCard, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.bentoHeader}>
          <View style={[styles.bentoIcon, { backgroundColor: t.surface2, borderColor: t.border }]}>
            <AlertTriangle size={10} color={t.textTertiary} />
          </View>
          <Text style={[typeScale.caption, { color: t.textPrimary, fontWeight: "600" }]}>Open by priority</Text>
        </View>
        <View style={styles.priorityGrid}>
          {(
            [
              { key: "urgent", label: "Urgent", color: t.danger, bg: withAlpha(t.danger, 0.12) },
              { key: "high", label: "High", color: t.warning, bg: withAlpha(t.warning, 0.12) },
              { key: "medium", label: "Medium", color: t.info, bg: withAlpha(t.info, 0.12) },
              { key: "low", label: "Low", color: t.textTertiary, bg: t.surface2 },
            ] as const
          ).map(({ key, label, color, bg }) => {
            const counts = focus === "overdue" || focus === "today" ? filteredPriorityCounts : priorityCounts;
            const n = (counts as unknown as Record<string, number>)[key] ?? 0;
            const active = n > 0;
            return (
              <View key={key} style={[styles.priorityTile, { backgroundColor: bg, borderColor: active ? (color === t.textTertiary ? t.border : withAlpha(color, 0.3)) : t.border }]}>
                <Text style={[typeScale.heading, { color: active ? color : t.textTertiary }]}>{n}</Text>
                <Text style={[typeScale.micro, { color: t.textTertiary, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase", fontSize: 10 }]}>{label}</Text>
                <Text style={[typeScale.micro, { color: t.textTertiary, fontSize: 10, marginTop: 2 }]}>{n ? `${n} open` : "—"}</Text>
              </View>
            );
          })}
        </View>
        <View style={[styles.wipRow, { backgroundColor: t.surface2, borderColor: t.border }]}>
          <Text style={[typeScale.caption, { color: t.textTertiary, fontSize: 12 }]}>WIP — {inProgressCount} in progress</Text>
          <Text style={[typeScale.caption, { color: t.textPrimary, fontWeight: "600", fontSize: 12 }]}>
            {wipLimit ? (
              <>
                Limit {wipLimit} · <Text style={{ color: wipStatus === "over" ? t.danger : wipStatus === "at limit" ? t.warning : t.success }}>{wipStatus}</Text>
              </>
            ) : (
              <Text style={{ color: t.textTertiary }}>No limit</Text>
            )}
          </Text>
        </View>
      </View>

      {/* ── health radar ── */}
      <HealthRadar axes={radarAxes} size={260} />

      {/* ── notes summary ── */}
      <View style={[styles.notesCard, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.notesHeader}>
          <View style={styles.bentoHeader}>
            <View style={[styles.bentoIcon, { backgroundColor: t.surface2, borderColor: t.border }]}>
              <FileText size={10} color={t.textTertiary} />
            </View>
            <Text style={[typeScale.caption, { color: t.textPrimary, fontWeight: "600" }]}>Notes</Text>
            <Text style={[typeScale.micro, { color: t.textTertiary }]}> · {totalNotes} total{pinneNotesLabel(pinnedNotes.length)} · {recentNotes.length} recent</Text>
          </View>
          <Pressable onPress={nav.onViewNotes}>
            <Text style={[typeScale.caption, { color: t.accent, fontWeight: "600", fontSize: 12 }]}>Open notes →</Text>
          </Pressable>
        </View>
        {totalNotes === 0 ? (
          <Text style={[typeScale.caption, { color: t.textTertiary, textAlign: "center", paddingVertical: 16 }]}>No notes yet — capture ideas to see them here</Text>
        ) : (
          <View style={{ gap: 16 }}>
            <View>
              <View style={styles.notesSubHeader}>
                <Pin size={10} color={t.textTertiary} />
                <Text style={[typeScale.micro, { color: t.textTertiary, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase", fontSize: 10 }]}>Pinned · keeps focus</Text>
              </View>
              {pinnedNotes.length === 0 ? (
                <Text style={[typeScale.caption, { color: t.textTertiary, fontSize: 12, paddingVertical: 8 }]}>No pinned notes</Text>
              ) : (
                <View style={{ gap: 0 }}>
                  {pinnedNotes.slice(0, 3).map((n) => {
                    const row = noteById.get(n.id);
                    const snippet = row ? stripMarkdown(row.content ?? "").trim().slice(0, 64) : "";
                    return (
                      <Pressable key={n.id} onPress={() => nav.onOpenNote(n.id)} style={[styles.noteRow, { borderBottomColor: t.border }]}>
                        <View style={[styles.noteIcon, { backgroundColor: t.surface2, borderColor: t.border }]}>
                          <Pin size={10} color={t.textTertiary} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[typeScale.control, { color: t.textPrimary, fontWeight: "500", fontSize: 14 }]} numberOfLines={1}>
                            {n.title || "Untitled"}
                          </Text>
                          <Text style={[typeScale.caption, { color: t.textTertiary, fontSize: 12 }]} numberOfLines={1}>
                            {snippet || "Empty note"}
                          </Text>
                        </View>
                        <Text style={[typeScale.micro, { color: t.textTertiary, fontFamily: "Menlo", fontSize: 10 }]}>{formatRelative(n.updatedAt)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
            <View>
              <View style={styles.notesSubHeader}>
                <FileText size={10} color={t.textTertiary} />
                <Text style={[typeScale.micro, { color: t.textTertiary, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase", fontSize: 10 }]}>Recent</Text>
              </View>
              {recentNotes.length === 0 ? (
                <Text style={[typeScale.caption, { color: t.textTertiary, fontSize: 12, paddingVertical: 8 }]}>No recent notes</Text>
              ) : (
                <View style={{ gap: 0 }}>
                  {recentNotes.slice(0, 4).map((n) => {
                    const row = noteById.get(n.id);
                    const preview = row ? stripMarkdown(row.content ?? "").trim().slice(0, 64) : "";
                    const isDashboard = false; // mobile notes are all type note
                    return (
                      <Pressable key={n.id} onPress={() => nav.onOpenNote(n.id)} style={[styles.noteRow, { borderBottomColor: t.border }]}>
                        <View style={[styles.noteIcon, { backgroundColor: t.surface2, borderColor: t.border }]}>
                          {isDashboard ? <LayoutDashboard size={10} color={t.textTertiary} /> : <FileText size={10} color={t.textTertiary} />}
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[typeScale.control, { color: t.textSecondary, fontWeight: "500", fontSize: 14 }]} numberOfLines={1}>
                            {n.title || "Untitled"}
                          </Text>
                          <Text style={[typeScale.caption, { color: t.textTertiary, fontSize: 12 }]} numberOfLines={1}>
                            {preview || "Empty note"}
                          </Text>
                        </View>
                        <Text style={[typeScale.micro, { color: t.textTertiary, fontFamily: "Menlo", fontSize: 10 }]}>{formatRelative(n.updatedAt)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          </View>
        )}
      </View>

      {/* ── activity log ── */}
      <View style={[styles.activityCard, { backgroundColor: t.surface, borderColor: t.border, borderLeftColor: withAlpha(t.accent, 0.6) }]}>
        <View style={styles.activityHeader}>
          <View style={styles.bentoHeader}>
            <View style={[styles.bentoIcon, { backgroundColor: t.surface2, borderColor: t.border }]}>
              <Activity size={10} color={t.textTertiary} />
            </View>
            <Text style={[typeScale.caption, { color: t.textPrimary, fontWeight: "600" }]}>Activity log</Text>
            <Text style={[typeScale.micro, { color: t.textTertiary }]}> · full history</Text>
          </View>
          <Text style={[typeScale.micro, { color: t.textTertiary, fontFamily: "Menlo", fontSize: 10 }]}>
            {activityByDay.reduce((n, g) => n + g.items.length, 0)} events
          </Text>
        </View>
        {activityByDay.length === 0 ? (
          <Text style={[typeScale.caption, { color: t.textTertiary, textAlign: "center", paddingVertical: 16 }]}>No activity yet — changes will appear here</Text>
        ) : (
          <View style={{ gap: 12 }}>
            {activityByDay.map((group) => (
              <View key={group.label}>
                <Text style={[typeScale.micro, { color: t.textTertiary, fontWeight: "700", marginBottom: 4, fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase" }]}>{group.label}</Text>
                <View style={[styles.activityGroup, { backgroundColor: t.surface, borderColor: t.border }]}>
                  {group.items.map((item, i) => (
                    <Pressable
                      key={`${item.type}:${item.id}`}
                      onPress={() => (item.type === "note" ? nav.onOpenNote(item.id) : nav.onOpenCard(item.id))}
                      style={[styles.activityRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.borderSubtle }]}
                    >
                      {item.type === "note" ? <FileText size={13} color={t.info} /> : <CircleIcon size={13} color={t.accent} />}
                      <Text style={[typeScale.caption, { color: t.textPrimary, flex: 1, fontSize: 12 }]} numberOfLines={1}>
                        {item.title || (item.type === "note" ? "Untitled" : "Untitled task")}
                      </Text>
                      {!!item.subtitle && (
                        <Text style={[typeScale.micro, { color: t.textTertiary, fontSize: 10 }]} numberOfLines={1}>
                          {item.subtitle}
                        </Text>
                      )}
                      <Text style={[typeScale.micro, { color: t.textTertiary, fontFamily: "Menlo", fontSize: 10 }]}>{formatRelative(item.updatedAt)}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      {empty && <EmptyState title="Nothing here yet" subtitle="Add a note or a task to see this project's snapshot." align="top" />}

      {/* compact stat row kept for glanceability when empty filtered? hidden when instrument present but keep for minimal case */}
      {!project && (
        <View style={styles.statRow}>
          <StatCard icon={StickyNote} label="Notes" value={data.notes.length} color={t.info} onPress={nav.onViewNotes} t={t} />
          <StatCard icon={ListTodo} label="Open" value={openCards.length} color={t.accent} onPress={nav.onViewBoard} t={t} />
          <StatCard icon={AlertTriangle} label="Overdue" value={overdueCount} color={overdueCount > 0 ? t.danger : t.textTertiary} onPress={nav.onViewBoard} t={t} />
        </View>
      )}
    </ScrollView>
  );
}

function pinneNotesLabel(count: number): string {
  return count > 0 ? ` · ${count} pinned` : "";
}

function Pill({ label, color, t }: { label: string; color: string; t: Theme }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 3, paddingHorizontal: 9, borderRadius: 11, backgroundColor: withAlpha(color, 0.14) }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={[typeScale.micro, { color: t.textSecondary, fontWeight: "600" }]}>{label}</Text>
    </View>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
  onPress,
  t,
}: {
  icon: typeof StickyNote;
  label: string;
  value: number;
  color: string;
  onPress: () => void;
  t: Theme;
}) {
  return (
    <PressableScale onPress={onPress} style={[{ flex: 1, gap: 4, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, backgroundColor: t.surface, borderColor: t.border }, elevation.sm as StyleProp<ViewStyle>]}>
      <Icon size={16} color={color} />
      <Text style={[typeScale.heading, { color: t.textPrimary }]}>{value}</Text>
      <Text style={[typeScale.micro, { color: t.textTertiary }]}>{label}</Text>
    </PressableScale>
  );
}

function makeStyles(t: Theme) {
  void t;
  return StyleSheet.create({
    content: { padding: 12, paddingTop: 0, gap: 14 },
    masthead: { gap: 12 },
    mastheadLeft: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
    headerIcon: { width: 44, height: 44, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 1 },
    pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
    miniPill: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1 },
    codeRow: { flexDirection: "row", marginTop: 8 },
    codePill: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1 },
    codePillDashed: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderStyle: "dashed" },
    codeDot: { width: 6, height: 6, borderRadius: 3, marginLeft: 2 },
    instrument: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
    instrumentHead: {},
    instrumentMain: { flexDirection: "row", alignItems: "center", gap: 12 },
    meterTrack: { height: 6, borderRadius: 3, overflow: "hidden", flexDirection: "row", alignItems: "center", marginTop: 2 },
    meterFill: { height: "100%", borderRadius: 3 },
    meterTicks: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 1, alignItems: "center" },
    meterTick: { width: 1, height: "100%", opacity: 0.8 },
    instrumentDates: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
    viewBoardBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, alignItems: "center", marginTop: 4 },
    focusBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, flexWrap: "wrap" },
    focusPill: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1 },
    kpiStrip: { borderWidth: 1, borderRadius: 12, overflow: "hidden", flexDirection: "row", flexWrap: "wrap" },
    kpiCell: { width: "50%", padding: 12, gap: 2, position: "relative" },
    kpiCellTint: {},
    kpiAccent: { position: "absolute", top: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth },
    kpiLabel: { fontSize: 10, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" },
    kpiValueRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 4 },
    emptyQueue: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderStyle: "dashed" },
    emptyIcon: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1 },
    emptyAction: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1 },
    queueCard: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, borderWidth: 1 },
    queueIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1 },
    queueStripe: { width: 3, alignSelf: "stretch", borderRadius: 2, marginLeft: 6 },
    bentoCard: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 12 },
    bentoHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    bentoIcon: { width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", borderWidth: 1 },
    barRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
    barLabel: { width: 92, fontSize: 12, textAlign: "right" },
    barTrack: { flex: 1, height: 10, borderRadius: 10, overflow: "hidden", flexDirection: "row", alignItems: "center", padding: 2, borderWidth: 1 },
    barCount: { width: 24, textAlign: "right", fontSize: 12 },
    legendRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    priorityGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    priorityTile: { width: "48.2%", alignItems: "center", gap: 2, paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
    wipRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, marginTop: 4 },
    notesCard: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 12 },
    notesHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    notesSubHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
    noteRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
    noteIcon: { width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center", borderWidth: 1 },
    activityCard: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 12, borderLeftWidth: 2 },
    activityHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    activityGroup: { borderWidth: 1, borderRadius: 10, overflow: "hidden" },
    activityRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, paddingHorizontal: 12 },
    statRow: { flexDirection: "row", gap: 8 },
    card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
    dueRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
    priorityStripe: { width: 3, alignSelf: "stretch", borderRadius: 2 },
    recentRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  });
}
