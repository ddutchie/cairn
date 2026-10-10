import type { ReactNode } from "react";
import { Stack , ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/theme";

/**
 * Shared per-tab Stack navigator. Every tab wraps its screen in one of these so
 * the screen gets a NATIVE header (large title + optional native search bar)
 * that owns the top safe-area inset correctly — this is what removes the
 * double-inset gap you'd get from stacking a hand-rolled header under the tab's
 * own safe-area padding.
 *
 * The header styling (surface bg, accent tint, primary title) is unified here
 * so all tabs read identically and match the desktop tokens: the desktop app
 * header (topbar) and every view toolbar are both `--surface`, joined by a
 * hairline border, with content on `--background`. We mirror that by giving the
 * native header `t.surface` — so a tab's own surface toolbar (calendar / graph)
 * sits flush against the header with no colour seam (the light-mode grey-header
 * / white-toolbar strip is what this fixes), while the screen body stays
 * `t.background`.
 */
export function TabStack({
  largeTitle = true,
  children,
}: {
  largeTitle?: boolean;
  children?: ReactNode;
} = {}) {
  const scheme = useColorScheme();
  const t = useTheme();
  // Horizontal insets are 0 on a portrait iPhone, but an unfolded iPhone Duo
  // (and landscape) puts system chrome — status bar, nav buttons, the tab rail —
  // along a side edge. Keep screen content clear of it.
  const { left, right } = useSafeAreaInsets();
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerLargeTitle: largeTitle,
          headerStyle: { backgroundColor: t.surface },
          headerLargeTitleStyle: { color: t.textPrimary },
          headerTitleStyle: { color: t.textPrimary },
          headerTintColor: t.accent,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.background, paddingLeft: left, paddingRight: right },
        }}
      >
        {children}
      </Stack>
    </ThemeProvider>
  );
}
