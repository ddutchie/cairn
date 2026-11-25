import { PixelGameRoute } from "@/components/PixelGameRoute";
import { PowderRunView } from "@/components/PowderRunGame";

/** The hidden Powder Run 3D snowboard game as a full-screen route. */
export default function PowderRunRoute() {
  return (
    <PixelGameRoute>
      <PowderRunView />
    </PixelGameRoute>
  );
}
