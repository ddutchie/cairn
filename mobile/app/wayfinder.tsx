import { PixelGameRoute } from "@/components/PixelGameRoute";
import { WayfinderView } from "@/components/WayfinderGame";

/** The hidden Wayfinder easter egg as a full-screen route (see PixelGameRoute). */
export default function WayfinderRoute() {
  return (
    <PixelGameRoute>
      <WayfinderView />
    </PixelGameRoute>
  );
}
