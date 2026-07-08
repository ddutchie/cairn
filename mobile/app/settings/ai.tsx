import { useRouter } from "expo-router";
import { AiSettingsForm } from "@/components/AiSettingsForm";
import { useModalOpenHaptic } from "@/haptics";

/**
 * AI settings presented as a native form-sheet modal. Uses the native
 * navigation header + a Stack.Toolbar checkmark to save — the same pattern as
 * the new-note / new-task modals — so it looks consistent. The form (which
 * owns save/loading state) renders those via expo-router's Stack. Saving (the
 * checkmark) or swipe-down dismisses back to the caller (the chat screen),
 * which re-checks provider availability on focus.
 */
export default function AiSettingsScreen() {
  useModalOpenHaptic();
  const router = useRouter();
  const close = () => {
    if (router.canGoBack()) router.back();
  };
  return <AiSettingsForm onClose={close} />;
}
