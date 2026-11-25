import { PixelGameRoute } from "@/components/PixelGameRoute";
import { WorkspaceGameView } from "@/components/WorkspaceGame";

/** The idle office as a full-screen route (see PixelGameRoute). */
export default function OfficeRoute() {
  return (
    <PixelGameRoute>
      <WorkspaceGameView />
    </PixelGameRoute>
  );
}
