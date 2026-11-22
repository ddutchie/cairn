import { ProjectScreen } from "@/screens/ProjectScreen";

// One project detail, mounted in every tab's stack (array group), so the native
// tab bar stays visible; re-tapping the Projects tab pops back to its list.
export default function Screen() {
  return <ProjectScreen />;
}
