import { useLocalSearchParams, useRouter } from "expo-router";
import { useModalOpenHaptic } from "@/haptics";
import { useTheme } from "@/theme";
import { ModalSafeView } from "@/components/ModalSafeView";
import { TaskComposer } from "@/components/TaskComposer";

/**
 * New-task composer as a native modal. `project` (id) required; `column`
 * optionally pre-selects the destination column (passed from the board).
 * Creates the card locally so capture triggers stage it for sync.
 *
 * The form itself lives in `TaskComposer` (shared with the split-view detail
 * column on wide layouts); this route only adds the modal haptic + routing.
 */
export default function NewCard() {
  useModalOpenHaptic();
  const { project, column, back } = useLocalSearchParams<{ project: string; column?: string; back?: string }>();
  const router = useRouter();
  const t = useTheme();

  return (
    <ModalSafeView backgroundColor={t.surface}>
      <TaskComposer
        projectId={project ?? ""}
        column={column}
        back={back}
        // Replace this modal with the new card's detail. Forward `back` (the
        // project name) so the card's header shows "< {Project}" instead of the
        // raw route group name ("(tabs)").
        onSaved={(id) => router.replace({ pathname: "/card/[id]", params: { id, ...(back ? { back } : {}) } })}
      />
    </ModalSafeView>
  );
}
