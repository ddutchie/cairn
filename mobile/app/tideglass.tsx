import { PixelGameRoute } from "@/components/PixelGameRoute";
import { TideglassView } from "@/components/TideglassGame";

/** The hidden Tideglass game as a full-screen route (see PixelGameRoute). */
export default function TideglassRoute() {
  return (
    <PixelGameRoute>
      <TideglassView />
    </PixelGameRoute>
  );
}
