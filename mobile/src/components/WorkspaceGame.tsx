import { useRouter, type Href } from "expo-router";
import { haptics } from "@/haptics";
import { PixelGameView, type PixelGame, type PixelGameSpec } from "@/components/PixelGameView";
import { skiaBackend } from "@/games/pixel/skia-backend";
import { loadOfficeData } from "@/db/arcade";
import { OfficeRenderer } from "@cairn/shared/arcade/workspace/render";
import { OfficeSim } from "@cairn/shared/arcade/workspace/sim";

/** Poll the workspace this often (steps run at 60 Hz): the sim animates between polls. */
const POLL_STEPS = 180;

/**
 * The idle office (`/office`): your workspace mirrored live. A tap opens the
 * real card or note; the robot opens chat. Office events carry their ref, so
 * the host navigates synchronously on tap instead of via string events.
 */
export function WorkspaceGameView() {
  const router = useRouter();
  const openTask = (id: string) => router.push({ pathname: "/card/[id]", params: { id } } as Href);
  const openNote = (id: string) => router.push({ pathname: "/note/[id]", params: { id } } as Href);
  const openChat = () => router.push("/chat" as Href);

  function create({ width, height, hud }: PixelGameSpec): PixelGame<string> {
    let fp = "";
    const sim = new OfficeSim({ width, height, hud, inputMode: "touch", seed: 7 });
    try {
      const first = loadOfficeData();
      fp = first.fingerprint;
      sim.setData(first.office);
    } catch {
      // DB not ready: the demo office stands in until the first poll lands.
    }
    const renderer = new OfficeRenderer(skiaBackend, sim);
    let n = 0;
    const drain = () => {
      for (const e of sim.events.splice(0)) {
        haptics.selection();
        if (e.k === "open") {
          if (sim.data.demo) continue;
          if (e.ref.type === "task") openTask(e.ref.id);
          else openNote(e.ref.id);
        } else openChat();
      }
    };
    return {
      // String-event channel unused: taps navigate (and buzz) synchronously above.
      events: [],
      get best() {
        return 0;
      },
      get calm() {
        return sim.calm;
      },
      set calm(v) {
        sim.calm = v;
      },
      step: () => {
        sim.step();
        if (++n < POLL_STEPS) return;
        n = 0;
        try {
          const next = loadOfficeData();
          if (next.fingerprint !== fp) {
            fp = next.fingerprint;
            sim.setData(next.office);
          }
        } catch {
          // DB mid-sync: keep the last good snapshot until the next poll.
        }
      },
      draw: () => renderer.draw(),
      resize: (w, h, h2) => renderer.resize(w, h, h2),
      down: (x, y) => {
        sim.down(x, y);
        drain();
      },
      move: (x, y) => sim.move(x, y),
      up: () => sim.up(),
      cancel: () => sim.cancel(),
    };
  }

  return <PixelGameView create={create} bestKey="office_best" onEvent={() => {}} />;
}
