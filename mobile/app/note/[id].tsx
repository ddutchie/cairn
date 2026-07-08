import { NoteDetailScreen } from "@/screens/NoteDetailScreen";

// Root-stack note detail (reached from Search, Graph, Conflicts). The Projects
// tab uses the nested copy at app/(tabs)/projects/note/[id].
export default function Screen() {
  return <NoteDetailScreen />;
}
