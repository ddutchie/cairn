import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Alert } from "react-native";
import { Check, X, Plus } from "lucide-react-native";
import { useRouter, type Href } from "expo-router";
import { PressableScale } from "@/components/PressableScale";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import {
  addNoteAttendee, attendeeCandidates, confirmNoteAttendee, loadNoteMeeting, removeNoteAttendee,
  type NoteMeetingStrip, type StripAttendee,
} from "@/db/people";
import { formatDate } from "@cairn/shared/format/date";
import type { Person } from "@cairn/shared/types/people";

/**
 * Who was at this note's meeting, above the note body (People layer, flag on).
 * Confirmed attendees open their person page; suggested ones (an ambiguous name,
 * or a line in the body) carry a tick to confirm and a cross to dismiss; the
 * `+` chip adds someone. Writes go through the shared claim model, so the
 * desktop merges them with whatever its own sources say.
 *
 * Renders nothing for a note with no meeting while the picker is closed, so a
 * plain note looks the same as before; "Add attendees" in the note menu opens
 * the picker (the parent bumps `addRequest`).
 */
export function AttendeeStrip({ noteId, addRequest }: { noteId: string; addRequest: number }) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const [strip, setStrip] = useState<NoteMeetingStrip>({ meetingId: null, startsAt: null, attendees: [] });
  const [candidates, setCandidates] = useState<Person[]>([]);

  const load = useCallback(() => {
    try {
      setStrip(loadNoteMeeting(noteId));
    } catch {
      // The People tables are missing on an install that never migrated; show nothing.
    }
  }, [noteId]);
  useRefreshOnFocus(load);

  const [pickerOpen, setPickerOpen] = useState(false);
  const refreshCandidates = useCallback(() => {
    try {
      setCandidates(attendeeCandidates(noteId));
    } catch {
      setCandidates([]);
    }
  }, [noteId]);
  const openPicker = useCallback(() => {
    refreshCandidates();
    setPickerOpen(true);
  }, [refreshCandidates]);
  // The parent's "Add attendees" bumps `addRequest`; react to the change while rendering (no effect needed).
  const [lastRequest, setLastRequest] = useState(addRequest);
  if (addRequest !== lastRequest) {
    setLastRequest(addRequest);
    openPicker();
  }

  const act = (fn: () => void) => {
    haptics.selection();
    try {
      fn();
    } catch (e) {
      Alert.alert("Couldn't update attendees", e instanceof Error ? e.message : String(e));
    }
    load();
    refreshCandidates();
  };

  const open = (a: StripAttendee) => router.push({ pathname: "/workspace/people/[id]", params: { id: a.personId } } as Href);

  if (!strip.meetingId && !pickerOpen) return null;

  return (
    <>
      {strip.meetingId ? (
        <View style={s.wrap}>
          {strip.startsAt ? <Text style={s.when}>{formatDate(strip.startsAt)}</Text> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
            {strip.attendees.map((a) =>
              a.status === "suggested" ? (
                <View key={a.personId} style={[s.chip, s.suggested]}>
                  <Text style={s.suggestedName} numberOfLines={1}>{a.name}?</Text>
                  <PressableScale hitSlop={8} onPress={() => act(() => confirmNoteAttendee(noteId, a.personId))} accessibilityLabel={`Confirm ${a.name}`}>
                    <Check size={14} color={t.accent} />
                  </PressableScale>
                  <PressableScale hitSlop={8} onPress={() => act(() => removeNoteAttendee(noteId, a.personId))} accessibilityLabel={`Dismiss ${a.name}`}>
                    <X size={14} color={t.textTertiary} />
                  </PressableScale>
                </View>
              ) : (
                <View key={a.personId} style={s.chip}>
                  <PressableScale onPress={() => open(a)} accessibilityLabel={`Open ${a.name}`}>
                    <Text style={s.name} numberOfLines={1}>{a.name}</Text>
                  </PressableScale>
                  <PressableScale hitSlop={8} onPress={() => act(() => removeNoteAttendee(noteId, a.personId))} accessibilityLabel={`Remove ${a.name}`}>
                    <X size={14} color={t.textTertiary} />
                  </PressableScale>
                </View>
              ),
            )}
            <PressableScale
              style={[s.chip, s.add]}
              onPress={openPicker}
              accessibilityLabel="Add attendee"
            >
              <Plus size={14} color={t.textSecondary} />
            </PressableScale>
          </ScrollView>
        </View>
      ) : null}

      <BottomSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} maxHeight="70%">
        <BottomSheetHeader title="Add attendees" onCancel={() => setPickerOpen(false)} />
        <ScrollView style={s.pickerList}>
          {candidates.length === 0 ? (
            <Text style={s.empty}>Everyone you know is already here. To add someone new, add them on desktop.</Text>
          ) : (
            candidates.map((p) => (
              <PressableScale
                key={p.id}
                style={s.pickerRow}
                onPress={() => act(() => { addNoteAttendee(noteId, p.id); })}
                accessibilityLabel={`Add ${p.name}`}
              >
                <Text style={s.pickerName}>{p.name}</Text>
              </PressableScale>
            ))
          )}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    wrap: { marginTop: 10, gap: 6 },
    when: { ...typeScale.caption, color: t.textTertiary },
    row: { gap: 8, alignItems: "center", paddingRight: 8 },
    chip: {
      flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 12,
      borderRadius: 16, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    name: { ...typeScale.caption, color: t.textPrimary, fontWeight: "600" },
    suggested: { borderStyle: "dashed", backgroundColor: "transparent" },
    suggestedName: { ...typeScale.caption, color: t.textSecondary },
    add: { paddingHorizontal: 10 },
    pickerList: { maxHeight: 420 },
    pickerRow: { paddingVertical: 12, paddingHorizontal: 18 },
    pickerName: { ...typeScale.control, color: t.textPrimary },
    empty: { ...typeScale.body, color: t.textTertiary, padding: 18 },
  });
}
