import { useEffect, useState } from "react";
import { Stack, ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { View, Text, ActivityIndicator, StyleSheet, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as SplashScreen from "expo-splash-screen";
import { initDatabase } from "@/db";
import { startAutoSync, onDataChanged } from "@/sync/controller";
import { catchUpIndex } from "@/notes/embeddings";
import { UpdateBanner } from "@/components/UpdateBanner";
import { useTheme } from "@/theme";

// Keep the native splash up until the DB is ready, so there's no flash between
// the splash and the first screen. Fade it out for a smooth handoff.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 300, fade: true });

export default function RootLayout() {
  const t = useTheme();
  const scheme = useColorScheme();
  // Open the DB once, synchronously, during the first render — the whole app
  // depends on it, so there's no meaningful "before DB" UI to show. A lazy
  // useState initializer runs exactly once and keeps the DB init OUT of an
  // effect (avoids the cascading setState-in-effect the linter flags).
  const [{ ready, error }] = useState<{ ready: boolean; error: string | null }>(() => {
    try {
      initDatabase();
      return { ready: true, error: null };
    } catch (e) {
      return { ready: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // NOTE: the status bar is intentionally NOT controlled from JS. With
  // UIUserInterfaceStyle=Automatic + UIStatusBarStyle=UIStatusBarStyleDefault
  // (set natively via plugins/withStatusBarStyle.js), iOS resolves the
  // status-bar content colour per light/dark mode itself — flash-free. Driving
  // it from JS (expo-status-bar / setStatusBarStyle) fought the native window
  // default during appearance changes, causing a white→black flash. See
  // github.com/expo/expo/issues/8002.

  useEffect(() => {
    // The DB is already open (see the lazy initializer above). If it failed,
    // skip all startup side-effects — the error screen renders instead.
    if (error) return;
    // Sync startup is non-fatal: a failure here must NOT show the "Database
    // error" screen (the DB opened fine). Guard it separately.
    try {
      startAutoSync();
    } catch (e) {
      console.warn("[sync] auto-sync failed to start:", e);
    }

    // On-device semantic-search index catch-up. Runs after first paint so it
    // never blocks startup; incremental + hash-gated, so an already-indexed
    // workspace finishes near-instantly. No-op when embeddings are unavailable
    // (older iOS / Android / Expo Go). Re-run after any inbound sync that may
    // have pulled in or imported new notes.
    const kickoff = setTimeout(() => {
      catchUpIndex().catch((e) => console.warn("[embeddings] initial catch-up failed:", e));
    }, 1200);
    const unsub = onDataChanged(() => {
      catchUpIndex().catch((e) => console.warn("[embeddings] catch-up after sync failed:", e));
    });
    return () => {
      clearTimeout(kickoff);
      unsub();
    };
  }, [error]);

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
            <Stack screenOptions={{ headerShown: true, ...headerStyle }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
              <Stack.Screen name="project/calendar" options={{ title: "Calendar" }} />
              <Stack.Screen name="note/new" options={{ title: "New Note", presentation: "modal" }} />
              <Stack.Screen name="note/[id]" options={{ title: "Note" }} />
              <Stack.Screen name="card/new" options={{ title: "New Task", presentation: "modal" }} />
              <Stack.Screen name="card/[id]" options={{ title: "Task" }} />
              <Stack.Screen name="sync" options={{ title: "Sync", presentation: "modal" }} />
              <Stack.Screen name="conflicts" options={{ title: "Sync Conflicts" }} />
              <Stack.Screen name="settings/ai" options={{ title: "AI settings", presentation: "modal" }} />
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
