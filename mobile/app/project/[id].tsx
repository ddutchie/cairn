import { ProjectScreen } from "@/screens/ProjectScreen";

// Root-stack project detail (reached from the Graph tab). Pushes over the tab
// bar. The Projects tab uses the nested copy at app/(tabs)/projects/project/[id].
export default function Screen() {
  return <ProjectScreen />;
}
