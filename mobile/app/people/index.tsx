import { PeopleScreen } from "@/screens/PeopleScreen";

// People layer (feature flag `feature.people`): the screen renders nothing while the flag is off.
export default function Screen() {
  return <PeopleScreen />;
}
