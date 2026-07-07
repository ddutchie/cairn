import { useEffect, useState } from "react";
import { Stack, ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, Text, ActivityIndicator, StyleSheet, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as SplashScreen from "expo-splash-screen";
import { initDatabase } from "@/db";
import { startAutoSync } from "@/sync/controller";
import { UpdateBanner } from "@/components/UpdateBanner";
import { useTheme } from "@/theme";

// Keep the native splash up until the DB is ready, so there's no flash between
// the splash and the first screen. Fade it out for a smooth handoff.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 300, fade: true });

export default function RootLayout() {
  const t = useTheme();
  const scheme = useColorScheme();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      initDatabase();
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    // Sync startup is non-fatal: a failure here must NOT show the "Database
    // error" screen (the DB opened fine). Guard it separately.
    try {
      startAutoSync();
    } catch (e) {
      console.warn("[sync] auto-sync failed to start:", e);
    }
  }, []);

  // Hide the native splash once we've either loaded or hit an error, so the
  // splash never lingers past the point the UI is ready to show.
  useEffect(() => {
    if (ready || error) SplashScreen.hideAsync().catch(() => {});
  }, [ready, error]);

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: t.background }]}>
        <Text style={[styles.error, { color: t.danger }]}>Database error</Text>
        <Text style={[styles.errorDetail, { color: t.textTertiary }]}>{error}</Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={[styles.center, { backgroundColor: t.background }]}>
        <ActivityIndicator color={t.accent} />
        <Text style={[styles.loading, { color: t.textTertiary }]}>Opening Cairn…</Text>
      </View>
    );
  }

  const headerStyle = {
    headerStyle: { backgroundColor: t.surface },
    headerTintColor: t.accent,
    headerTitleStyle: { color: t.textPrimary },
    contentStyle: { backgroundColor: t.background },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          {/* ThemeProvider drives the navigator theme so screen transitions and
              iOS 26 liquid-glass toolbar buttons don't flash a light background
              in dark mode (see Expo "Stack Toolbar → Common problems"). */}
          <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: true, ...headerStyle }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
              <Stack.Screen name="note/new" options={{ title: "New Note", presentation: "modal" }} />
              <Stack.Screen name="note/[id]" options={{ title: "Note" }} />
              <Stack.Screen name="card/new" options={{ title: "New Task", presentation: "modal" }} />
              <Stack.Screen name="card/[id]" options={{ title: "Task" }} />
              <Stack.Screen name="sync" options={{ title: "Sync", headerBackTitle: "Projects" }} />
              <Stack.Screen name="conflicts" options={{ title: "Sync Conflicts" }} />
            </Stack>
          </ThemeProvider>
          <UpdateBanner />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  loading: { marginTop: 12 },
  error: { fontSize: 18, fontWeight: "600" },
  errorDetail: { marginTop: 8, textAlign: "center" },
});
