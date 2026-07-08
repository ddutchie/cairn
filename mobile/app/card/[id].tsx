import { CardDetailScreen } from "@/screens/CardDetailScreen";

// Root-stack task detail (reached from Search, Graph, Calendar). The Projects
// tab uses the nested copy at app/(tabs)/projects/card/[id].
export default function Screen() {
  return <CardDetailScreen />;
}
