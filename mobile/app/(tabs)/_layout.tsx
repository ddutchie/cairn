import { NativeTabs } from "expo-router/unstable-native-tabs";
import { ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";

/**
 * Native platform tab bar with SF Symbols (iOS) / Material icons (Android).
 * Projects is the root (matching the desktop hierarchy: workspace → projects →
 * notes/board). Board lives inside a project, not as a top-level tab.
 */
export default function TabsLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf="folder.fill" md="folder" />
          <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="search" role="search">
          <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
          <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="chat">
          <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right.fill" md="chat" />
          <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
