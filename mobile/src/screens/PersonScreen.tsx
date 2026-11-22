import { useCallback, useMemo, useState } from "react";
import { Alert, View, Text, ScrollView, StyleSheet, TextInput } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { Check, Circle, Lock, X } from "lucide-react-native";
import { ICON_EDIT, ICON_PEOPLE } from "@/components/toolbar-icons";
import { ScreenChrome } from "@/components/screen-chrome";
import { PressableScale } from "@/components/PressableScale";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import { PickerPage } from "@/components/PickerPage";
import { NotFound } from "@/components/NotFound";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import {
  addTeamMember, endTeamMember, loadPastTeams, type PastTeam, loadPeople, loadPersonPage, loadTeams, mergePeople, moveToTeam, saveProfile, saveRelationship,
  setActionItemDone, setPersonStatus, type OpenItem, type OpenItems, type ProfileEdit,
} from "@/db/people";
import { cleanProfileField, PROFILE_FIELDS, type ProfileField } from "@cairn/shared/people/parse";
import { CADENCE_LABELS, RELATIONSHIP_LABELS, describeRelation } from "@cairn/shared/people/model";
import { formatDate, formatRelative } from "@cairn/shared/format/date";
import { KIND_LABEL } from "@/lib/team-labels";
import { CADENCES, RELATIONSHIP_TYPES, type Cadence, type Relationship, type RelationshipType, type Team } from "@cairn/shared/types/people";
import type { PersonPage, PersonSummary, PersonTimelineItem } from "@cairn/shared/types/people-view";

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
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(false);
  const [pastTeams, setPastTeams] = useState<PastTeam[]>([]);
  const [teamSheet, setTeamSheet] = useState<"add" | "move" | "same" | null>(null);

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

  const failed = (title: string, e: unknown) => Alert.alert(title, e instanceof Error ? e.message : String(e));
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
  /** Fold `dropId` into `keepId` after a confirm; the page follows whoever stays. */
  const merge = (keepId: string, keepName: string, dropId: string, dropName: string) =>
    Alert.alert(`Merge ${dropName} into ${keepName}?`, "Their meetings, notes, tasks and teams move over, and the name becomes an alias.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Merge", style: "destructive",
        onPress: () => {
          try {
            mergePeople(keepId, dropId);
          } catch (e) {
            return failed("Couldn't merge", e);
          }
          setDetails(false);
          setTeamSheet(null);
          if (keepId !== person.id) router.replace({ pathname: "/workspace/people/[id]", params: { id: keepId } } as Href);
          else load();
        },
      },
    ]);

  return (
    <View style={s.root}>
      <ScreenChrome
        title={person.name}
        right={[
          { kind: "button", key: "details", label: "Details", icon: ICON_PEOPLE, onPress: () => setDetails(true) },
          { kind: "button", key: "edit", label: "Edit", icon: ICON_EDIT, onPress: () => setEditing(true) },
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
                  <PressableScale onPress={() => setTeamSheet("same")} accessibilityLabel="Same as someone you know">
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
            <PressableScale onPress={() => setTeamSheet("add")} accessibilityLabel="Add to a team">
              <Text style={[s.action, { color: t.accent }]}>Add to a team</Text>
            </PressableScale>
            <PressableScale onPress={() => setTeamSheet("move")} accessibilityLabel="Move to a new team">
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

      <TeamSheets
        mode={teamSheet}
        person={person}
        onClose={() => setTeamSheet(null)}
        onAdd={(teamId) => {
          try {
            addTeamMember({ teamId, personId: person.id });
          } catch (e) {
            return failed("Couldn't add", e);
          }
          setTeamSheet(null);
          load();
        }}
        onMove={(name) => {
          // A guild or project name is refused (a home team is a team): say so and keep the sheet open.
          try {
            moveToTeam(person.id, name);
          } catch (e) {
            return failed("Couldn't move", e);
          }
          setTeamSheet(null);
          load();
        }}
        onSame={(other) => merge(other.id, other.name, person.id, person.name)}
      />
      <DetailsSheet
        visible={details}
        person={person}
        onMerge={(other) => merge(person.id, person.name, other.id, other.name)}
        onClose={() => setDetails(false)}
        onSave={(edit) => {
          // A team name that is a guild or project is refused (a home team is a team): say so and keep the sheet open.
          try {
            saveProfile(person.id, edit);
          } catch (e) {
            Alert.alert("Couldn't save", e instanceof Error ? e.message : String(e));
            return;
          }
          setDetails(false);
          load();
        }}
      />
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

const FIELD_LABEL: Record<ProfileField, string> = { title: "Role", team: "Team", location: "Location", timezone: "Time zone" };

/** Role, team, location, time zone and Slack id. A time zone is checked before saving. */
function DetailsSheet({ visible, person, onClose, onSave, onMerge }: {
  visible: boolean; person: PersonPage["person"]; onClose: () => void; onSave: (edit: Partial<ProfileEdit>) => void;
  onMerge: (other: PersonSummary) => void;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [vals, setVals] = useState<ProfileEdit>({ title: "", team: "", location: "", timezone: "", slackId: "" });
  // What the sheet opened with: save sends only what the user changed, so a sync that landed meanwhile isn't overwritten.
  const [opened, setOpened] = useState<ProfileEdit>({ title: "", team: "", location: "", timezone: "", slackId: "" });
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [others, setOthers] = useState<PersonSummary[]>([]);
  // Re-seed from the person each time the sheet opens.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    setPicking(false);
    // Whoever this could be a duplicate of: anyone else but you (merging drops them, and "you" must stay).
    try {
      setOthers(loadPeople(["confirmed", "suggested"]).filter((p) => p.id !== person.id && !p.isMe));
    } catch {
      setOthers([]);
    }
    const seed = { title: person.title ?? "", team: person.team ?? "", location: person.location ?? "", timezone: person.timezone ?? "", slackId: person.slackId ?? "" };
    setVals(seed);
    setOpened(seed);
    setError(null);
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }
  const set = (key: keyof ProfileEdit) => (text: string) => {
    setVals((v) => ({ ...v, [key]: text }));
    setError(null);
  };
  const save = () => {
    for (const f of PROFILE_FIELDS) {
      const { error: err } = cleanProfileField(f, vals[f]);
      if (err) return setError(err);
    }
    if (vals.slackId.trim() && !/^[A-Za-z0-9]{3,32}$/.test(vals.slackId.trim())) return setError("A Slack id looks like U01ABCDEF.");
    const changed: Partial<ProfileEdit> = {};
    for (const k of Object.keys(vals) as (keyof ProfileEdit)[]) if (vals[k].trim() !== opened[k].trim()) changed[k] = vals[k];
    onSave(changed);
  };
  const input = (key: keyof ProfileEdit, label: string, placeholder: string) => (
    <View key={key} style={{ marginTop: 14 }}>
      <Text style={s.sectionTitle}>{label}</Text>
      <TextInput
        style={s.input}
        value={vals[key]}
        onChangeText={set(key)}
        placeholder={placeholder}
        placeholderTextColor={t.textTertiary}
        autoCapitalize={key === "timezone" || key === "slackId" ? "none" : "sentences"}
        autoCorrect={false}
        accessibilityLabel={label}
      />
    </View>
  );
  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="80%" avoidKeyboard>
      {picking ? (
        <PickerPage
          title="Same person as"
          options={others.map((p) => ({ value: p.id, label: p.name, note: p.status === "suggested" ? "Suggested" : p.title }))}
          onBack={() => setPicking(false)}
          onPick={(id) => {
            const other = others.find((p) => p.id === id);
            if (other) onMerge(other);
          }}
        />
      ) : (
      <>
      <BottomSheetHeader title="Details" onCancel={onClose} onDone={save} />
      <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
        {input("title", FIELD_LABEL.title, "Senior software engineer")}
        {input("team", FIELD_LABEL.team, "Sync")}
        {input("location", FIELD_LABEL.location, "Berlin, Germany")}
        {input("timezone", FIELD_LABEL.timezone, "Europe/Berlin")}
        {input("slackId", "Slack id", "U01ABCDEF")}
        {error ? <Text style={[s.empty, { color: t.danger, marginTop: 12 }]} accessibilityRole="alert">{error}</Text> : null}
        {others.length > 0 ? (
          <View style={{ marginTop: 22 }}>
            <Text style={s.sectionTitle}>Duplicate</Text>
            <PressableScale style={s.pick} onPress={() => setPicking(true)} accessibilityLabel="Same person as…">
              <Text style={s.line}>Same person as…</Text>
              <Text style={s.chevron}>›</Text>
            </PressableScale>
            <Text style={[s.itemNote, { marginTop: 6 }]}>Their meetings, notes, tasks and teams move here; their name becomes an alias.</Text>
          </View>
        ) : null}
      </ScrollView>
      </>
      )}
    </BottomSheet>
  );
}

/** The team sheets: add to a team, move to a new one, or (for a suggestion) pick who they are. */
function TeamSheets({ mode, person, onClose, onAdd, onMove, onSame }: {
  mode: "add" | "move" | "same" | null; person: PersonPage["person"]; onClose: () => void;
  onAdd: (teamId: string) => void; onMove: (name: string) => void; onSame: (other: PersonSummary) => void;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [name, setName] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [last, setLast] = useState<typeof mode>(null);
  // Re-seed each time a sheet opens.
  if (mode !== last) {
    setLast(mode);
    if (mode) {
      setName("");
      try {
        setTeams(loadTeams().filter((tm) => !person.teams.some((x) => x.teamId === tm.id)));
        setPeople(loadPeople(["confirmed"]).filter((p) => p.id !== person.id));
      } catch {
        setTeams([]);
        setPeople([]);
      }
    }
  }
  return (
    <BottomSheet visible={mode !== null} onClose={onClose} maxHeight="80%" avoidKeyboard>
      {mode === "add" ? (
        <PickerPage
          title="Add to a team"
          options={teams.map((tm) => ({ value: tm.id, label: tm.name, note: tm.kind !== "team" ? KIND_LABEL[tm.kind] : undefined }))}
          empty="They are on every team."
          onBack={onClose}
          onPick={onAdd}
        />
      ) : mode === "same" ? (
        <PickerPage
          title="Same person as"
          options={people.map((p) => ({ value: p.id, label: p.name, note: p.title }))}
          empty="Nobody to pick yet."
          onBack={onClose}
          // The person you already have stays; this suggestion folds into them.
          onPick={(id) => {
            const other = people.find((p) => p.id === id);
            if (other) onSame(other);
          }}
        />
      ) : mode === "move" ? (
        <>
          <BottomSheetHeader title="Move to a new team" onCancel={onClose} onDone={name.trim() ? () => onMove(name) : undefined} />
          <View style={s.sheet}>
            <Text style={s.sectionTitle}>Team</Text>
            <TextInput
              style={s.input}
              value={name}
              onChangeText={setName}
              placeholder="Sync"
              placeholderTextColor={t.textTertiary}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={name.trim() ? () => onMove(name) : undefined}
              accessibilityLabel="Team name"
            />
            <Text style={[s.itemNote, { marginTop: 8 }]}>
              Takes them off their other teams (guilds, projects and committees stay). A name that is not a team yet makes one.
            </Text>
          </View>
        </>
      ) : null}
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
