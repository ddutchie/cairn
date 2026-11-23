import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { Circle, Lock, X } from "lucide-react-native";
import { ICON_EDIT, ICON_PEOPLE } from "@/components/toolbar-icons";
import { ScreenChrome } from "@/components/screen-chrome";
import { PressableScale } from "@/components/PressableScale";
import { NotFound } from "@/components/NotFound";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { haptics, toolbarPress } from "@/haptics";
import { newSheetResultKey, registerSheetResult } from "@/lib/sheet-result";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import {
  endTeamMember, loadPastTeams, type PastTeam, loadPersonPage,
  setActionItemDone, setPersonStatus, type OpenItem, type OpenItems,
} from "@/db/people";
import { CADENCE_LABELS, RELATIONSHIP_LABELS, describeRelation } from "@cairn/shared/people/model";
import { formatDate, formatRelative } from "@cairn/shared/format/date";
import { KIND_LABEL } from "@/lib/team-labels";
import type { PersonPage, PersonTimelineItem } from "@cairn/shared/types/people-view";

type Page = PersonPage & { items: OpenItems };

/**
 * A person's page (People layer, flag on): how they relate to you and how
 * often you meet, what each of you owes the other, the timeline (meetings with
 * their notes, mentions, cards) and a link to their persona note. Relationship
 * and cadence are editable here; ticking an item rewrites its checkbox in the
 * note. The prep brief and Slack lookup are desktop-only.
 */
export function PersonScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [page, setPage] = useState<Page | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pastTeams, setPastTeams] = useState<PastTeam[]>([]);

  const load = useCallback(() => {
    try {
      const next = id ? loadPersonPage(id) : null;
      setPage(next);
      setPastTeams(next ? loadPastTeams(next.person.id, next.person.teams) : []);
    } catch {
      setPage(null);
      setPastTeams([]);
    }
    setLoaded(true);
  }, [id]);
  useRefreshOnFocus(load);

  if (loaded && !page) return <NotFound label="Person" />;
  if (!page) return <View style={s.root} />;

  const { person } = page;
  const openNote = (noteId: string) => router.push({ pathname: "/note/[id]", params: { id: noteId } });
  const tick = (item: OpenItem) => {
    haptics.selection();
    // A false result (the note changed since it was listed) just reloads the list.
    setActionItemDone(item.noteId, item.lineKey, true, item.bodyDigest);
    load();
  };

  const leave = (teamId: string) => {
    haptics.selection();
    endTeamMember(teamId, person.id);
    load();
  };
  const decide = (status: "confirmed" | "dismissed") => {
    haptics.selection();
    setPersonStatus(person.id, status);
    load();
  };
  /** Open one of this person's native modal forms; a merge sends the page to whoever stays. */
  const openForm = (pathname: string, extra: Record<string, string> = {}) => {
    const key = newSheetResultKey();
    registerSheetResult<{ keepId?: string } | string>(key, (result) => {
      const keepId = typeof result === "object" ? result.keepId : undefined;
      if (keepId && keepId !== person.id) router.replace({ pathname: "/workspace/people/[id]", params: { id: keepId } } as Href);
      else load();
    });
    router.push({ pathname, params: { id: person.id, resultKey: key, ...extra } } as Href);
  };

  return (
    <View style={s.root}>
      <ScreenChrome
        title={person.name}
        right={[
          { kind: "button", key: "details", label: "Details", icon: ICON_PEOPLE, onPress: toolbarPress(() => openForm("/person-details")) },
          { kind: "button", key: "edit", label: "Edit", icon: ICON_EDIT, onPress: toolbarPress(() => openForm("/person-relationship")) },
        ]}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={s.content}>
        {person.status === "suggested" || person.status === "dismissed" ? (
          <View style={s.banner} accessibilityRole="summary">
            <Text style={s.bannerText}>
              {person.status === "dismissed"
                ? "You dismissed this person, so they stay out of your list and capture won't propose them again."
                : "Suggested from a note or by the assistant. Confirm to add them to your people."}
            </Text>
            <View style={s.bannerActions}>
              <PressableScale onPress={() => decide("confirmed")} accessibilityLabel={person.status === "dismissed" ? "Add back" : "Confirm"}>
                <Text style={[s.action, { color: t.accent }]}>{person.status === "dismissed" ? "Add back" : "Confirm"}</Text>
              </PressableScale>
              {person.status === "suggested" ? (
                <>
                  <PressableScale onPress={() => openForm("/person-team", { mode: "same" })} accessibilityLabel="Same as someone you know">
                    <Text style={[s.action, { color: t.accent }]}>Same as…</Text>
                  </PressableScale>
                  <PressableScale onPress={() => decide("dismissed")} accessibilityLabel="Dismiss">
                    <Text style={[s.action, { color: t.textTertiary }]}>Dismiss</Text>
                  </PressableScale>
                </>
              ) : null}
            </View>
          </View>
        ) : null}
        <Text style={s.name}>{person.name}</Text>
        {[person.title, person.team, person.location].filter(Boolean).length > 0 || person.timezone ? (
          <Text style={s.profile} accessibilityLabel="Profile">
            {[person.title, person.team, person.location, person.timezone].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
        <View style={s.chips}>
          {person.relationship.map((r, i) => (
            <View key={`${r.type}-${i}`} style={s.chip}><Text style={s.chipText}>{r.label ?? RELATIONSHIP_LABELS[r.type]}</Text></View>
          ))}
          {person.agentPrivate ? (
            <View style={s.chip}>
              <Lock size={11} color={t.textTertiary} />
              <Text style={s.chipText}>Private from agents</Text>
            </View>
          ) : null}
        </View>
        <Text style={s.meta}>
          {[
            person.cadence ? `${CADENCE_LABELS[person.cadence]} 1:1` : "",
            page.lastMetAt ? `last met ${formatRelative(page.lastMetAt)}` : "no meetings yet",
            page.nextMeetingAt ? `next ${formatDate(page.nextMeetingAt)}` : "",
          ].filter(Boolean).join(" · ")}
        </Text>

        {page.relations.length > 0 ? (
          <Section title="Relationships" s={s}>
            {page.relations.map((r) => (
              <PressableScale
                key={r.edge.id}
                onPress={() => router.push({ pathname: "/workspace/people/[id]", params: { id: r.otherId } } as Href)}
                accessibilityLabel={describeRelation(r)}
              >
                <Text style={[s.line, r.edge.endedAt ? { color: t.textTertiary } : null]}>{describeRelation(r)}</Text>
              </PressableScale>
            ))}
          </Section>
        ) : null}

        <Section title="Teams" s={s}>
          {person.teams.length > 0 ? (
            <View style={[s.chips, { marginTop: 0 }]} accessibilityLabel="Their teams">
              {person.teams.map((tm) => (
                <View key={tm.teamId} style={[s.chip, s.teamChip]}>
                  <PressableScale
                    onPress={() => router.push({ pathname: "/workspace/people/team/[id]", params: { id: tm.teamId } } as Href)}
                    accessibilityLabel={`Open ${tm.name}`}
                  >
                    <Text style={s.chipText}>
                      {tm.name}
                      {tm.role || tm.kind !== "team" ? <Text style={s.chipNote}>{` · ${tm.role ?? KIND_LABEL[tm.kind].toLowerCase()}`}</Text> : null}
                    </Text>
                  </PressableScale>
                  <PressableScale hitSlop={10} onPress={() => leave(tm.teamId)} accessibilityLabel={`Take them off ${tm.name}`}>
                    <X size={13} color={t.textTertiary} />
                  </PressableScale>
                </View>
              ))}
            </View>
          ) : (
            <Text style={s.empty}>Not on a team.</Text>
          )}
          <View style={s.teamActions}>
            <PressableScale onPress={() => openForm("/person-team", { mode: "add" })} accessibilityLabel="Add to a team">
              <Text style={[s.action, { color: t.accent }]}>Add to a team</Text>
            </PressableScale>
            <PressableScale onPress={() => openForm("/person-team", { mode: "move" })} accessibilityLabel="Move to a new team">
              <Text style={[s.action, { color: t.accent }]}>Move to a new team</Text>
            </PressableScale>
          </View>
          {pastTeams.length > 0 ? (
            <Text style={s.itemNote}>Before: {pastTeams.map((p) => `${p.team.name} (until ${formatDate(p.endedAt)})`).join(", ")}</Text>
          ) : null}
        </Section>

        <ItemsSection title={`${person.name.split(" ")[0]} owes`} items={page.items.theyOwe} onTick={tick} onOpen={openNote} s={s} t={t} />
        <ItemsSection title="You owe" items={page.items.iOwe} onTick={tick} onOpen={openNote} s={s} t={t} />

        {page.persona ? (
          <Section title="Persona" s={s}>
            <PressableScale onPress={() => openNote(page.persona!.id)} accessibilityLabel={`Open ${page.persona.title}`}>
              <Text style={[s.line, { color: t.accent }]}>{page.persona.title}</Text>
            </PressableScale>
          </Section>
        ) : null}

        <Section title="Timeline" s={s}>
          {page.timeline.length === 0 ? <Text style={s.empty}>Nothing yet.</Text> : null}
          {page.timeline.map((item, i) => <TimelineRow key={i} item={item} onNote={openNote} onCard={(cardId) => router.push({ pathname: "/card/[id]", params: { id: cardId } })} s={s} />)}
        </Section>
      </ScrollView>

    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function Section({ title, children, s }: { title: string; children: React.ReactNode; s: Styles }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ItemsSection({ title, items, onTick, onOpen, s, t }: {
  title: string; items: OpenItem[]; onTick: (i: OpenItem) => void; onOpen: (noteId: string) => void; s: Styles; t: Theme;
}) {
  if (items.length === 0) return null;
  return (
    <Section title={title} s={s}>
      {items.map((item) => (
        <View key={`${item.noteId}:${item.lineKey}`} style={s.item}>
          <PressableScale hitSlop={10} onPress={() => onTick(item)} accessibilityLabel={`Mark done: ${item.text}`}>
            <Circle size={20} color={t.textTertiary} />
          </PressableScale>
          <PressableScale style={s.itemBody} onPress={() => onOpen(item.noteId)} accessibilityLabel={item.text}>
            <Text style={s.itemText}>{item.text}</Text>
            <Text style={s.itemNote} numberOfLines={1}>{item.noteTitle}</Text>
          </PressableScale>
        </View>
      ))}
    </Section>
  );
}

function TimelineRow({ item, onNote, onCard, s }: { item: PersonTimelineItem; onNote: (id: string) => void; onCard: (id: string) => void; s: Styles }) {
  if (item.kind === "meeting") {
    const note = item.notes[0];
    return (
      <PressableScale onPress={note ? () => onNote(note.id) : undefined} style={s.tl} accessibilityLabel={item.meeting.title}>
        <Text style={s.line}>{item.meeting.title}</Text>
        <Text style={s.itemNote}>
          {[formatDate(item.at), item.with.length ? `with ${item.with.map((w) => w.name).join(", ")}` : ""].filter(Boolean).join(" · ")}
        </Text>
      </PressableScale>
    );
  }
  if (item.kind === "mention") {
    return (
      <PressableScale onPress={() => onNote(item.note.id)} style={s.tl} accessibilityLabel={item.note.title}>
        <Text style={s.line}>{item.note.title}</Text>
        <Text style={s.itemNote}>Mentioned · {formatDate(item.at)}</Text>
      </PressableScale>
    );
  }
  return (
    <PressableScale onPress={() => onCard(item.card.id)} style={s.tl} accessibilityLabel={item.card.title}>
      <Text style={s.line}>{item.card.title}</Text>
      <Text style={s.itemNote}>{item.card.done ? "Done" : item.card.columnName || "Task"} · {formatDate(item.at)}</Text>
    </PressableScale>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    content: { padding: 18, paddingBottom: 64 },
    name: { ...typeScale.display, color: t.textPrimary },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
    chip: {
      flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 5, paddingHorizontal: 11,
      borderRadius: 14, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    chipOn: { borderColor: t.accent, backgroundColor: t.accentDim },
    chipText: { ...typeScale.caption, color: t.textSecondary, fontWeight: "600" },
    profile: { ...typeScale.body, color: t.textSecondary, marginTop: 4 },
    input: {
      ...typeScale.body, color: t.textPrimary, marginTop: 6, paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    meta: { ...typeScale.caption, color: t.textTertiary, marginTop: 10 },
    section: { marginTop: 24, gap: 8 },
    sectionTitle: { ...typeScale.overline, color: t.textTertiary },
    line: { ...typeScale.body, color: t.textPrimary },
    empty: { ...typeScale.body, color: t.textTertiary },
    item: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 4 },
    itemBody: { flex: 1 },
    itemText: { ...typeScale.body, color: t.textPrimary },
    itemNote: { ...typeScale.caption, color: t.textTertiary },
    tl: { paddingVertical: 4 },
    sheet: { padding: 18, paddingBottom: 32 },
    teamChip: { paddingRight: 8 },
    chipNote: { ...typeScale.caption, color: t.textTertiary, fontWeight: "400" },
    teamActions: { flexDirection: "row", gap: 18 },
    action: { ...typeScale.caption, fontWeight: "600" },
    pick: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, paddingVertical: 12, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    chevron: { ...typeScale.title, fontWeight: "400", color: t.textTertiary },
    banner: {
      marginBottom: 14, padding: 12, gap: 8, borderRadius: 10, backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    bannerText: { ...typeScale.caption, color: t.textSecondary },
    bannerActions: { flexDirection: "row", gap: 18 },
  });
}
