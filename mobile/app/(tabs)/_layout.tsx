import { NativeTabs } from "expo-router/unstable-native-tabs";
import { ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";
import { useTheme } from "@/theme";

/**
 * Native platform tab bar with SF Symbols (iOS) / Material icons (Android).
 * Projects is the root (matching the desktop hierarchy: workspace → projects →
 * notes/board). Board lives inside a project, not as a top-level tab.
 */
export default function TabsLayout() {
  const colorScheme = useColorScheme();
  const t = useTheme();
  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      {/* tintColor accents the selected tab (icon + label) with our brand
          accent instead of the platform default blue. minimizeBehavior
          collapses the tab bar as you scroll down for more content room. */}
      <NativeTabs tintColor={t.accent} minimizeBehavior="onScrollDown">
        <NativeTabs.Trigger name="projects">
          <NativeTabs.Trigger.Icon sf="folder.fill" md="folder" />
          <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="calendar">
          <NativeTabs.Trigger.Icon sf="calendar" md="calendar_month" />
          <NativeTabs.Trigger.Label>Calendar</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="graph">
          <NativeTabs.Trigger.Icon sf="point.3.connected.trianglepath.dotted" md="hub" />
          <NativeTabs.Trigger.Label>Graph</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="chat">
          <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right.fill" md="chat" />
          <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        {/* Search last so it sits on the far right — matches the iOS search-tab
            convention and keeps it out of the primary nav flow. */}
        <NativeTabs.Trigger name="search" role="search">
          <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
          <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
