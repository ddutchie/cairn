import { PixelGameRoute } from "@/components/PixelGameRoute";
import { BasecampView } from "@/components/BasecampGame";

/** The hidden Basecamp game as a full-screen route (see PixelGameRoute). */
export default function BasecampRoute() {
  return (
    <PixelGameRoute>
      <BasecampView />
    </PixelGameRoute>
  );
}
