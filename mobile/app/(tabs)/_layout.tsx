import { NativeTabs } from "expo-router/unstable-native-tabs";
import { ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";

/**
 * Native platform tab bar (iOS UITabBar / Android Material tabs) via
 * expo-router native tabs. Uses SF Symbols on iOS and Material Symbols on
 * Android for real system icons — the JavaScript <Tabs> we had before showed
 * no icons and a non-native bar.
 *
 * Wrapped in ThemeProvider so the tab bar / content background follows the
 * system colour scheme (avoids the white-flash-on-switch issue on iOS 26).
 */
export default function TabsLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf={{ default: "note.text", selected: "note.text" }} md="description" />
          <NativeTabs.Trigger.Label>Notes</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="board">
          <NativeTabs.Trigger.Icon sf="square.grid.2x2" md="grid_view" />
          <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="search" role="search">
          <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
          <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="sync">
          <NativeTabs.Trigger.Icon sf="arrow.triangle.2.circlepath" md="sync" />
          <NativeTabs.Trigger.Label>Sync</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
