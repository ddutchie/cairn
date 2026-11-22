import { useRouter } from "expo-router";
import { AiSettingsForm } from "@/components/AiSettingsForm";

/** Provider and model: the screen the AI settings hub opens. Saves on Save, then goes back. */
export default function ModelSettingsScreen() {
  const router = useRouter();
  const close = () => {
    if (router.canGoBack()) router.back();
  };
  return <AiSettingsForm section="model" onClose={close} />;
}
