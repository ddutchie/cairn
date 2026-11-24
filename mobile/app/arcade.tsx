import { PixelGameRoute } from "@/components/PixelGameRoute";
import { ArcadeView } from "@/components/ArcadeMenu";

/** The Cairn Arcade: the hidden pixel game picker (see PixelGameRoute). */
export default function ArcadeRoute() {
  return (
    <PixelGameRoute>
      <ArcadeView />
    </PixelGameRoute>
  );
}
