import { useLocalSearchParams, useRouter } from "expo-router";
import { CaptureSheet } from "@/components/capture/CaptureSheet";
import { useModalOpenHaptic } from "@/haptics";

/**
 * Quick capture as a native modal. `text` pre-fills the field (deep link
 * `cairn://capture?text=…`, App Intents, share hand-offs); `autostart=1` files it
 * immediately so a dictated or shared thought lands on the confirm card with no
 * extra tap.
 */
export default function Capture() {
  useModalOpenHaptic();
  // A repeated key (cairn://capture?text=a&text=b) arrives as an array at runtime.
  const params = useLocalSearchParams<{ text?: string | string[]; autostart?: string | string[] }>();
  const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
  const text = first(params.text);
  const autostart = first(params.autostart);
  const router = useRouter();
  return <CaptureSheet initialText={text ?? ""} autostart={autostart === "1"} onClose={() => router.back()} />;
}
