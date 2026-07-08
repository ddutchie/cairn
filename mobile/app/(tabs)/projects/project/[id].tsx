import { ProjectScreen } from "@/screens/ProjectScreen";

// Projects-tab project detail — nested in the tab stack so the native tab bar
// stays visible and re-tapping the Projects tab pops back to the project list.
export default function Screen() {
  return <ProjectScreen nested />;
}
