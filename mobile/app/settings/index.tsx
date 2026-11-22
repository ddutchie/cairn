import { Stack, useRouter } from "expo-router";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { toolbarPress, useModalOpenHaptic } from "@/haptics";
import { ModalSafeView } from "@/components/ModalSafeView";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { useTheme } from "@/theme";

/** The settings hub: the first screen of the settings modal. Done closes the modal. */
export default function SettingsHub() {
  useModalOpenHaptic();
  const t = useTheme();
  const router = useRouter();
  const close = () => {
    if (router.canGoBack()) router.back();
  };
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={ICON_CHECK} variant="done" accessibilityLabel="Done" onPress={toolbarPress(close)}>
          Done
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {/* Clears the Duo's side rail when the modal spans the window. */}
      <ModalSafeView backgroundColor={t.background}>
        <SettingsScreen />
      </ModalSafeView>
    </>
  );
}
