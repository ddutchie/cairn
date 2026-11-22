import { NoteDetailScreen } from "@/screens/NoteDetailScreen";

// One note detail, mounted in every tab's stack (array group), so a note opened
// from any tab keeps the tab bar and goes back to where you came from.
export default function Screen() {
  return <NoteDetailScreen />;
}
