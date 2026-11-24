import { PixelGameRoute } from "@/components/PixelGameRoute";
import { InboxZeroView } from "@/components/InboxZeroGame";

/** The hidden Inbox Zero easter egg as a full-screen route (see PixelGameRoute). */
export default function InboxZeroRoute() {
  return (
    <PixelGameRoute>
      <InboxZeroView />
    </PixelGameRoute>
  );
}
