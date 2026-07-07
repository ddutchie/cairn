import { Stack , ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";
import { useTheme } from "@/theme";

/**
 * Shared per-tab Stack navigator. Every tab wraps its screen in one of these so
 * the screen gets a NATIVE header (large title + optional native search bar)
 * that owns the top safe-area inset correctly — this is what removes the
 * double-inset gap you'd get from stacking a hand-rolled header under the tab's
 * own safe-area padding.
 *
 * The header styling (surface bg, accent tint, primary title) is unified here
 * so all four tabs read identically and match the desktop tokens.
 */
export function TabStack({ largeTitle = true }: { largeTitle?: boolean } = {}) {
  const scheme = useColorScheme();
  const t = useTheme();
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerLargeTitle: largeTitle,
          headerStyle: { backgroundColor: t.background },
          headerLargeTitleStyle: { color: t.textPrimary },
          headerTitleStyle: { color: t.textPrimary },
          headerTintColor: t.accent,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.background },
        }}
      />
    </ThemeProvider>
  );
}
