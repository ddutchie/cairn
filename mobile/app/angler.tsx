import { PixelGameRoute } from "@/components/PixelGameRoute";
import { AnglerView } from "@/components/AnglerGame";

/** Angler, the fishing and aquarium game, as a full-screen route (see PixelGameRoute). */
export default function AnglerRoute() {
  return (
    <PixelGameRoute>
      <AnglerView />
    </PixelGameRoute>
  );
}
