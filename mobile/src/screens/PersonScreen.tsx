import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, Circle, Lock } from "lucide-react-native";
import { ScreenChrome } from "@/components/screen-chrome";
import { PressableScale } from "@/components/PressableScale";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import { NotFound } from "@/components/NotFound";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { loadPersonPage, saveRelationship, setActionItemDone, type OpenItem, type OpenItems } from "@/db/people";
import { usePeopleEnabled } from "@/people/flag";
import { CADENCE_LABELS, RELATIONSHIP_LABELS, describeRelation } from "@cairn/shared/people/model";
import { formatDate, formatRelative } from "@cairn/shared/format/date";
import { CADENCES, RELATIONSHIP_TYPES, type Cadence, type Relationship, type RelationshipType } from "@cairn/shared/types/people";
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
  const on = usePeopleEnabled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [page, setPage] = useState<Page | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    try {
      setPage(id ? loadPersonPage(id) : null);
    } catch {
      setPage(null);
    }
    setLoaded(true);
  }, [id]);
  useRefreshOnFocus(load);

  if (!on) return null;
  if (loaded && !page) return <NotFound label="Person" />;
  if (!page) return <View style={s.root} />;

  const { person } = page;
  const openNote = (noteId: string) => router.push({ pathname: "/note/[id]", params: { id: noteId, back: person.name } });
  const tick = (item: OpenItem) => {
    haptics.selection();
    // A false result (the note changed since it was listed) just reloads the list.
    setActionItemDone(item.noteId, item.lineKey, true, item.bodyDigest);
    load();
  };

  return (
    <View style={s.root}>
      <ScreenChrome
        title={person.name}
        right={[{ kind: "button", key: "edit", label: "Edit", onPress: () => setEditing(true) }]}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={s.content}>
        <Text style={s.name}>{person.name}</Text>
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
                onPress={() => router.push({ pathname: "/people/[id]", params: { id: r.otherId } })}
                accessibilityLabel={describeRelation(r)}
              >
                <Text style={s.line}>{describeRelation(r)}</Text>
              </PressableScale>
            ))}
          </Section>
        ) : null}

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

      <RelationshipSheet
        visible={editing}
        relationship={person.relationship}
        cadence={person.cadence ?? null}
        onClose={() => setEditing(false)}
        onSave={(rel, cadence) => {
          saveRelationship(person.id, rel, cadence);
          setEditing(false);
          load();
        }}
      />
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

/** Pick relationship types and a 1:1 cadence. Existing labels and provenance stay with the types that remain selected. */
function RelationshipSheet({ visible, relationship, cadence, onClose, onSave }: {
  visible: boolean; relationship: Relationship[]; cadence: Cadence | null; onClose: () => void;
  onSave: (relationship: Relationship[], cadence: Cadence | null) => void;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [types, setTypes] = useState<Set<RelationshipType>>(new Set());
  const [cad, setCad] = useState<Cadence | null>(null);
  // What the sheet opened with: save applies only what the user changed from it, on top of the latest person.
  const [opened, setOpened] = useState<{ types: Set<RelationshipType>; cad: Cadence | null }>({ types: new Set(), cad: null });
  // Re-seed from the person each time the sheet opens.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    setTypes(new Set(relationship.map((r) => r.type)));
    setCad(cadence);
    setOpened({ types: new Set(relationship.map((r) => r.type)), cad: cadence });
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }
  const toggle = (type: RelationshipType) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  const save = () => {
    // Sync may have changed the person while the sheet was open: remove only what the user unticked,
    // add only what they ticked, and keep the cadence they didn't touch.
    const removed = new Set([...opened.types].filter((x) => !types.has(x)));
    const kept = relationship.filter((r) => !removed.has(r.type));
    const have = new Set(kept.map((r) => r.type));
    const added: Relationship[] = [...types].filter((x) => !opened.types.has(x) && !have.has(x)).map((type) => ({ type, provenance: "explicit" }));
    onSave([...kept, ...added], cad !== opened.cad ? cad : cadence);
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="80%">
      <BottomSheetHeader title="Relationship" onCancel={onClose} onDone={save} />
      <ScrollView contentContainerStyle={s.sheet}>
        <Text style={s.sectionTitle}>Relationship to you</Text>
        <View style={s.chips}>
          {RELATIONSHIP_TYPES.map((type) => (
            <PressableScale key={type} onPress={() => toggle(type)} style={[s.chip, types.has(type) && s.chipOn]} accessibilityLabel={RELATIONSHIP_LABELS[type]}>
              {types.has(type) ? <Check size={12} color={t.accent} /> : null}
              <Text style={[s.chipText, types.has(type) && { color: t.accent }]}>{RELATIONSHIP_LABELS[type]}</Text>
            </PressableScale>
          ))}
        </View>
        <Text style={[s.sectionTitle, { marginTop: 18 }]}>1:1 cadence</Text>
        <View style={s.chips}>
          {([null, ...CADENCES] as (Cadence | null)[]).map((c) => (
            <PressableScale key={c ?? "none"} onPress={() => setCad(c)} style={[s.chip, cad === c && s.chipOn]} accessibilityLabel={c ? CADENCE_LABELS[c] : "No cadence"}>
              <Text style={[s.chipText, cad === c && { color: t.accent }]}>{c ? CADENCE_LABELS[c] : "None"}</Text>
            </PressableScale>
          ))}
        </View>
      </ScrollView>
    </BottomSheet>
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
  });
}
