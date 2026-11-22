import { useRouter } from "expo-router";
import { AiSettingsForm } from "@/components/AiSettingsForm";
import { useModalOpenHaptic } from "@/haptics";

/**
 * AI settings hub, a screen of the settings modal: live tuning (temperature, max
 * steps, personality, renderer, chat theme) and rows into Provider & model
 * (`settings/model`) and Tools. Done (or swipe-down) dismisses back to the
 * caller (e.g. Chat), which re-checks provider availability on focus.
 */
export default function AiSettingsScreen() {
  useModalOpenHaptic();
  const router = useRouter();
  const close = () => {
    if (router.canGoBack()) router.back();
  };
  return <AiSettingsForm onClose={close} />;
}
