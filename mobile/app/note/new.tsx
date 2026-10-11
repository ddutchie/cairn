import { useLocalSearchParams, useRouter } from "expo-router";
import { NoteComposer } from "@/components/NoteComposer";
import { useModalOpenHaptic } from "@/haptics";

/**
 * New-note composer as a native modal. `project` (id) is required; `folder`
 * optionally pre-fills the destination folder (passed from the project's
 * folder tree). On save we create the note locally (capture triggers stage it
 * for sync) and replace the route with the new note's detail screen.
 *
 * The form itself lives in `NoteComposer` (shared with the split-view detail
 * column on wide layouts); this route only adds the modal haptic + routing.
 */
export default function NewNote() {
  useModalOpenHaptic();
  const { project, folder } = useLocalSearchParams<{ project: string; folder?: string }>();
  const router = useRouter();

  return (
    <NoteComposer
      projectId={project ?? ""}
      folder={folder}
      onSaved={(id) => router.replace(`/note/${id}`)}
    />
  );
}
