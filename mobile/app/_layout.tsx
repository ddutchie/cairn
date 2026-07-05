import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { initDatabase } from "@/db";
import { useTheme } from "@/theme";

export default function RootLayout() {
  const t = useTheme();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      initDatabase();
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
    <KeyboardProvider>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: true, ...headerStyle }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
          <Stack.Screen name="note/[id]" options={{ title: "Note" }} />
        </Stack>
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  loading: { marginTop: 12 },
  error: { fontSize: 18, fontWeight: "600" },
  errorDetail: { marginTop: 8, textAlign: "center" },
});
