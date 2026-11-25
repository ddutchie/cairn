import { PixelGameRoute } from "@/components/PixelGameRoute";
import { StackerView } from "@/components/StackerGame";

/** The hidden Stacker easter egg as a full-screen route (see PixelGameRoute). */
export default function StackerRoute() {
  return (
    <PixelGameRoute>
      <StackerView />
    </PixelGameRoute>
  );
}
