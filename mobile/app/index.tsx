/**
 * Entry point — redirect to onboarding if no DB path is set,
 * otherwise to the main tab navigator.
 */
import { useEffect } from "react";
import { useRouter } from "expo-router";
import { View, ActivityIndicator } from "react-native";
import { useStore } from "../store/index";

export default function Index() {
  const router = useRouter();
  const dbPath = useStore((s) => s.dbPath);
  const workspaceId = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    // Give the _layout hydration a tick to settle
    const t = setTimeout(() => {
      if (!dbPath) {
        router.replace("/onboarding");
      } else if (!workspaceId) {
        router.replace("/onboarding");
      } else {
        router.replace("/(tabs)");
      }
    }, 50);
    return () => clearTimeout(t);
  }, [dbPath, workspaceId]);

  return (
    <View className="flex-1 items-center justify-center bg-zinc-950">
      <ActivityIndicator color="#6366f1" size="large" />
    </View>
  );
}
