import { PixelGameRoute } from "@/components/PixelGameRoute";
import { TaskForceView } from "@/components/TaskForceGame";

/** The hidden Task Force easter egg as a full-screen route (see PixelGameRoute). */
export default function TaskForceRoute() {
  return (
    <PixelGameRoute>
      <TaskForceView />
    </PixelGameRoute>
  );
}
