import { useMemo } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, RefreshControl, type StyleProp, type ViewStyle } from "react-native";
import { FileText, Circle as CircleIcon, Pin, StickyNote, ListTodo, AlertTriangle } from "lucide-react-native";
import { computeProjectMetrics } from "@cairn/shared/overview/metrics";
import { COLUMN_COLORS, PRIORITY_COLOR } from "@cairn/shared/ui/constants";
import { getDueDateStatus, formatRelative, parseIsoLocal } from "@cairn/shared/format/date";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { tagsByRow, type ProjectOverviewData, type NoteRow, type TagRow } from "@/db/queries";
import { SectionLabel } from "@/components/SectionLabel";
import { TagChips } from "@/components/TagChips";
import { ProjectIcon } from "@/components/ProjectIcon";
import { PressableScale } from "@/components/PressableScale";
import { EmptyState } from "@/components/EmptyState";
import { ProgressRing } from "./ProgressRing";
import { useTheme, withAlpha, elevation, type as typeScale, type Theme } from "@/theme";

/** Project status → theme colour token. Mirrors desktop STATUS_CSS_COLORS. */
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
 * Per-project Overview — the RN counterpart of the desktop ProjectOverview.
 * All numbers come from the shared computeProjectMetrics() so desktop and mobile
 * agree. Read-only for now (no edit popover / code-dir / tools panel — those are
 * desktop-only concepts, tracked as mobile follow-ups).
 */
export function OverviewTab({ data, nav, bottomPad, onRefresh, refreshing }: { data: ProjectOverviewData; nav: OverviewNav; bottomPad: number; onRefresh?: () => void; refreshing?: boolean }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

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

  // Resolve tags once for the pinned-note chips (parent-batched, no per-row DB).
  const noteById = useMemo(() => new Map(data.notes.map((n) => [n.id, n])), [data.notes]);
  const tagMap = useMemo(() => tagsByRow(data.notes), [data.notes]);

  const project = data.project;
  const { completionRate, doneCards, allCards, openCards, overdueCount, priorityCounts, hasAnyCategorised } = metrics;

  const empty = data.notes.length === 0 && allCards.length === 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.textTertiary} /> : undefined
      }
    >
      {/* Header: icon + status/priority/due pills, progress ring */}
      {project ? (
        <View style={styles.header}>
          <View style={[styles.headerIcon, { backgroundColor: t.accentDim }]}>
            <ProjectIcon name={project.icon} size={22} color={t.accent} />
          </View>
          <View style={{ flex: 1 }}>
            {!!project.description && (
              <Text style={[typeScale.caption, { color: t.textSecondary, marginBottom: 6 }]} numberOfLines={2}>
                {project.description}
              </Text>
            )}
            <View style={styles.pillRow}>
              <Pill label={prettyStatus(project.status)} color={statusColor(t, project.status)} t={t} />
              {project.priority && (
                <Pill label={prettyStatus(project.priority)} color={PRIORITY_COLOR[project.priority] ?? t.textTertiary} t={t} />
              )}
            </View>
          </View>
          {allCards.length > 0 && (
            <ProgressRing percent={completionRate} caption={`${doneCards.length} / ${allCards.length} done`} />
          )}
        </View>
      ) : null}

      {/* Stat cards */}
      <View style={styles.statRow}>
        <StatCard icon={StickyNote} label="Notes" value={data.notes.length} color={t.info} onPress={nav.onViewNotes} t={t} />
        <StatCard icon={ListTodo} label="Open" value={openCards.length} color={t.accent} onPress={nav.onViewBoard} t={t} />
        <StatCard
          icon={AlertTriangle}
          label="Overdue"
          value={overdueCount}
          color={overdueCount > 0 ? t.danger : t.textTertiary}
          onPress={nav.onViewBoard}
          t={t}
        />
      </View>

      {empty && (
        <EmptyState title="Nothing here yet" subtitle="Add a note or a task to see this project's snapshot." align="top" />
      )}

      {/* Column breakdown */}
      {allCards.length > 0 && metrics.columns.length > 0 && (
        <Section label="By column">
          <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
            {metrics.columns.map((col) => {
              const count = allCards.filter((c) => c.columnId === col.id).length;
              const pct = allCards.length > 0 ? (count / allCards.length) * 100 : 0;
              const color = COLUMN_COLORS[col.type] ?? t.textTertiary;
              return (
                <View key={col.id} style={styles.barRow}>
                  <Text style={[typeScale.caption, styles.barLabel, { color: t.textSecondary }]} numberOfLines={1}>
                    {col.name}
                  </Text>
                  <View style={[styles.barTrack, { backgroundColor: t.surface3 }]}>
                    <View style={{ width: `${pct}%`, height: "100%", borderRadius: 4, backgroundColor: color }} />
                  </View>
                  <Text style={[typeScale.caption, styles.barCount, { color: t.textTertiary }]}>{count}</Text>
                </View>
              );
            })}
          </View>
        </Section>
      )}

      {/* Priority breakdown */}
      {hasAnyCategorised && (
        <Section label="Open tasks by priority">
          <View style={styles.priorityGrid}>
            {(["urgent", "high", "medium", "low"] as const).map((p) => (
              <View
                key={p}
                style={[styles.priorityTile, { backgroundColor: withAlpha(PRIORITY_COLOR[p], 0.12), borderColor: withAlpha(PRIORITY_COLOR[p], 0.3) }]}
              >
                <Text style={[typeScale.heading, { color: PRIORITY_COLOR[p] }]}>{priorityCounts[p]}</Text>
                <Text style={[typeScale.micro, { color: t.textSecondary, textTransform: "capitalize" }]}>{p}</Text>
              </View>
            ))}
          </View>
        </Section>
      )}

      {/* Due soon */}
      {metrics.dueCards.length > 0 && (
        <Section label="Due soon">
          <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border, padding: 0 }]}>
            {metrics.dueCards.map((c, i) => {
              const status = getDueDateStatus(c.dueDate);
              const col = metrics.columns.find((cc) => cc.id === c.columnId);
              const chip = dueChipLabel(c.dueDate, status);
              const chipColor = status === "overdue" ? t.danger : status === "today" ? t.warning : t.textTertiary;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => nav.onOpenCard(c.id)}
                  style={[styles.dueRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.borderSubtle }]}
                >
                  <View style={[styles.priorityStripe, { backgroundColor: PRIORITY_COLOR[c.priority] ?? t.textTertiary }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[typeScale.control, { color: t.textPrimary, fontWeight: "500" }]} numberOfLines={1}>
                      {c.title}
                    </Text>
                    {!!col && <Text style={[typeScale.micro, { color: t.textTertiary }]}>{col.name}</Text>}
                  </View>
                  <Text style={[typeScale.micro, { color: chipColor, fontWeight: "600" }]}>{chip}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>
      )}

      {/* Pinned notes */}
      {metrics.pinnedNotes.length > 0 && (
        <Section label="Pinned">
          <View style={{ gap: 8 }}>
            {metrics.pinnedNotes.map((n) => (
              <NoteCard key={n.id} note={noteById.get(n.id)} tags={tagMap.get(n.id)} onPress={() => nav.onOpenNote(n.id)} pinned t={t} styles={styles} />
            ))}
          </View>
        </Section>
      )}

      {/* Recent notes */}
      {metrics.recentNotes.length > 0 && (
        <Section label="Recent notes">
          <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border, padding: 0 }]}>
            {metrics.recentNotes.map((n, i) => {
              const row = noteById.get(n.id);
              const preview = row ? stripMarkdown(row.content ?? "").trim().slice(0, 80) : "";
              return (
                <Pressable
                  key={n.id}
                  onPress={() => nav.onOpenNote(n.id)}
                  style={[styles.recentRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.borderSubtle }]}
                >
                  <FileText size={14} color={t.textTertiary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[typeScale.control, { color: t.textPrimary, fontWeight: "500" }]} numberOfLines={1}>
                      {n.title || "Untitled"}
                    </Text>
                    {!!preview && (
                      <Text style={[typeScale.micro, { color: t.textTertiary }]} numberOfLines={1}>
                        {preview}
                      </Text>
                    )}
                  </View>
                  <Text style={[typeScale.micro, { color: t.textTertiary }]}>{formatRelative(n.updatedAt)}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>
      )}

      {/* Recent activity */}
      {metrics.activityByDay.length > 0 && (
        <Section label="Recent activity">
          <View style={{ gap: 12 }}>
            {metrics.activityByDay.map((group) => (
              <View key={group.label}>
                <Text style={[typeScale.micro, { color: t.textTertiary, marginBottom: 4, fontWeight: "600" }]}>{group.label}</Text>
                <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border, padding: 0 }]}>
                  {group.items.map((item, i) => (
                    <Pressable
                      key={`${item.type}:${item.id}`}
                      onPress={() => (item.type === "note" ? nav.onOpenNote(item.id) : nav.onOpenCard(item.id))}
                      style={[styles.activityRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.borderSubtle }]}
                    >
                      {item.type === "note" ? <FileText size={13} color={t.info} /> : <CircleIcon size={13} color={t.accent} />}
                      <Text style={[typeScale.caption, { color: t.textPrimary, flex: 1 }]} numberOfLines={1}>
                        {item.title || (item.type === "note" ? "Untitled" : "Untitled task")}
                      </Text>
                      {!!item.subtitle && (
                        <Text style={[typeScale.micro, { color: t.textTertiary }]} numberOfLines={1}>
                          {item.subtitle}
                        </Text>
                      )}
                      <Text style={[typeScale.micro, { color: t.textTertiary }]}>{formatRelative(item.updatedAt)}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          </View>
        </Section>
      )}
    </ScrollView>
  );
}

/** "3d overdue" / "Today" / "in 2d" chip for a due date. */
function dueChipLabel(due: string | null, status: ReturnType<typeof getDueDateStatus>): string {
  if (!due) return "";
  if (status === "today") return "Today";
  const target = parseIsoLocal(due);
  const today = new Date();
  target.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `in ${days}d`;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{label}</SectionLabel>
      {children}
    </View>
  );
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
    <PressableScale
      onPress={onPress}
      style={[{ flex: 1, gap: 4, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, backgroundColor: t.surface, borderColor: t.border }, elevation.sm as StyleProp<ViewStyle>]}
    >
      <Icon size={16} color={color} />
      <Text style={[typeScale.heading, { color: t.textPrimary }]}>{value}</Text>
      <Text style={[typeScale.micro, { color: t.textTertiary }]}>{label}</Text>
    </PressableScale>
  );
}

function NoteCard({
  note,
  tags,
  onPress,
  pinned,
  t,
  styles,
}: {
  note?: NoteRow;
  tags?: TagRow[];
  onPress: () => void;
  pinned?: boolean;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (!note) return null;
  const preview = stripMarkdown(note.content ?? "").trim().slice(0, 120);
  return (
    <PressableScale onPress={onPress} style={[styles.card, { backgroundColor: t.surface, borderColor: t.border, gap: 4 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {pinned && <Pin size={11} color={t.accent} fill={t.accent} />}
        <Text style={[typeScale.control, { color: t.textPrimary, fontWeight: "600", flex: 1 }]} numberOfLines={1}>
          {note.title || "Untitled"}
        </Text>
      </View>
      {!!preview && (
        <Text style={[typeScale.caption, { color: t.textTertiary }]} numberOfLines={2}>
          {preview}
        </Text>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 }}>
        <Text style={[typeScale.micro, { color: t.textTertiary }]}>{formatRelative(note.updated_at)}</Text>
        {!!tags && tags.length > 0 && <TagChips tags={tags.slice(0, 2)} size="sm" />}
      </View>
    </PressableScale>
  );
}

function makeStyles(t: Theme) {
  // Colours are applied inline per-element (theme-reactive); this factory holds
  // only layout so styles stay static, but is keyed on `t` for symmetry with the
  // rest of the app's makeStyles pattern and future theme-dependent layout.
  void t;
  return StyleSheet.create({
    // paddingTop 0: the project screen wraps this in a container that already
    // clears the floating Overview|Notes|Board bar, so the scroll content's own
    // top padding would double it up.
    content: { padding: 12, paddingTop: 0, gap: 20 },
    header: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    headerIcon: { width: 44, height: 44, borderRadius: 11, alignItems: "center", justifyContent: "center" },
    pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    statRow: { flexDirection: "row", gap: 8 },
    card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
    barRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    barLabel: { width: 92 },
    barTrack: { flex: 1, height: 8, borderRadius: 4, overflow: "hidden" },
    barCount: { width: 24, textAlign: "right" },
    priorityGrid: { flexDirection: "row", gap: 8 },
    priorityTile: { flex: 1, alignItems: "center", gap: 2, paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
    dueRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
    priorityStripe: { width: 3, alignSelf: "stretch", borderRadius: 2 },
    recentRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
    activityRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, paddingHorizontal: 12 },
  });
}
