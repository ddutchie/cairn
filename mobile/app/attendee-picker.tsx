import { useCallback, useMemo, useState } from "react";
import { Alert, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Person } from "@cairn/shared/types/people";
import { addNoteAttendee, attendeeCandidates } from "@/db/people";
import { ModalForm } from "@/components/ModalForm";
import { PickerList } from "@/components/PickerList";
import { makeFormStyles } from "@/components/form-styles";
import { haptics } from "@/haptics";
import { useTheme } from "@/theme";

/**
 * Add attendees to a note's meeting (a native modal): tapping someone adds them at once and they leave the list, so
 * several can be added in a row. The note's attendee strip refreshes when this closes.
 */
export default function AttendeePicker() {
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const router = useRouter();
  const t = useTheme();
  const s = useMemo(() => makeFormStyles(t), [t]);
  const read = useCallback((): Person[] => {
    try { return noteId ? attendeeCandidates(noteId) : []; } catch { return []; }
  }, [noteId]);
  const [candidates, setCandidates] = useState<Person[]>(read);
  return (
    <ModalForm title="Add attendees" onBack={() => router.back()} scroll={false}>
      {candidates.length === 0 ? (
        <Text style={[s.empty, { padding: 18 }]}>Everyone you know is already here. To add someone new, add them in People.</Text>
      ) : (
        <PickerList
          options={candidates.map((p) => ({ value: p.id, label: p.name }))}
          onPick={(personId) => {
            haptics.selection();
            try {
              addNoteAttendee(noteId!, personId);
            } catch (e) {
              Alert.alert("Couldn't update attendees", e instanceof Error ? e.message : String(e));
            }
            setCandidates(read());
          }}
        />
      )}
    </ModalForm>
  );
}
