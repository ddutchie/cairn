import { Stack, ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";
import { useTheme } from "@/theme";

/**
 * Settings: one modal (presented by the root Stack) holding its own stack, so the
 * hub pushes AI settings, Tools, Appearance and Sync inside it instead of
 * stacking a second modal on top. Every entry point (Workspace, the Projects
 * menu, Chat's chip and + panel, the sync badge) opens `/settings` or one of its
 * children, so there is one URL per screen and no tab switching.
 */
export default function SettingsLayout() {
  const scheme = useColorScheme();
  const t = useTheme();
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerBackTitle: "Back",
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.accent,
          headerTitleStyle: { color: t.textPrimary },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.surface },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Settings" }} />
        <Stack.Screen name="ai" options={{ title: "AI settings" }} />
        <Stack.Screen name="providers" options={{ title: "AI Providers" }} />
        <Stack.Screen name="tools" options={{ title: "Tools & Services" }} />
        <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
        <Stack.Screen name="sync" options={{ title: "Sync" }} />
      </Stack>
    </ThemeProvider>
  );
}
