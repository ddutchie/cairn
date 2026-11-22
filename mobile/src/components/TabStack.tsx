import type { ReactNode } from "react";
import { Stack, ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useAccessoryInset } from "@/lib/workspace-tools";
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
/**
 * The tab screens' content style: themed background plus horizontal safe-area
 * insets. Horizontal insets are 0 on a portrait iPhone, but an iPhone Duo puts
 * system chrome — status bar, nav buttons, the tab rail — along a side edge, so
 * content must stay clear of it. Exported so a screen that overrides
 * `contentStyle` for one layout (e.g. a split view) can restore it for another.
 */
export function useTabContentStyle() {
  const t = useTheme();
  const { left, right } = useSafeAreaInsets();
  // The pinned tool's accessory floats over the bottom of the screen (everywhere
  // but the Workspace tab), so the content ends above it.
  const accessory = useAccessoryInset();
  return { backgroundColor: t.background, paddingLeft: left, paddingRight: right, paddingBottom: accessory };
}

/**
 * Title rule: every tab root and pushed screen gets the small inline title, so
 * the same band sits above every tab (a large title ate a third of the Duo's
 * closed display). Buttons go through `ScreenChrome` so the back label, haptics
 * and Duo side-rail overflow apply everywhere; Chat (glass header, model menu)
 * and Search (search bar) add their own header options on top. A screen that
 * really wants a large title can pass `largeTitle`.
 */
export function TabStack({
  largeTitle = false,
  children,
}: {
  largeTitle?: boolean;
  children?: ReactNode;
} = {}) {
  const scheme = useColorScheme();
  const t = useTheme();
  const contentStyle = useTabContentStyle();
  // With system chrome on a side edge (iPhone Duo's tab rail) a surface-coloured
  // header stops short of the rail and reads as a stray band, so it takes the
  // page colour there instead.
  const { left, right } = useSafeAreaInsets();
  const headerBackground = left > 0 || right > 0 ? t.background : t.surface;
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerLargeTitle: largeTitle,
          headerStyle: { backgroundColor: headerBackground },
          headerLargeTitleStyle: { color: t.textPrimary },
          headerTitleStyle: { color: t.textPrimary },
          headerTintColor: t.accent,
          headerShadowVisible: false,
          contentStyle,
        }}
      >
        {children}
      </Stack>
    </ThemeProvider>
  );
}
