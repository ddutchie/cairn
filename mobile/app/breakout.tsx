import { PixelGameRoute } from "@/components/PixelGameRoute";
import { BreakoutView } from "@/components/BreakoutGame";

/** The hidden Breakout easter egg as a full-screen route (see PixelGameRoute). */
export default function BreakoutRoute() {
  return (
    <PixelGameRoute>
      <BreakoutView />
    </PixelGameRoute>
  );
}
