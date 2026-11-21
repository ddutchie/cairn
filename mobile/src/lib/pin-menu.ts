import { ActionSheetIOS, Alert, Platform } from "react-native";
import { PINNABLE, WORKSPACE_TOOLS, setPinnedTool, type ToolId } from "@/lib/workspace-tools";

/** Press-and-hold menu on a Workspace row: pin it above the tab bar, or take it off. */
export function showPinMenu(id: ToolId, pinned: boolean): void {
  if (!PINNABLE.includes(id)) return;
  const title = WORKSPACE_TOOLS[id].title;
  const label = pinned ? "Remove from tab bar" : "Show above tab bar";
  const run = () => setPinnedTool(pinned ? null : id);
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [label, "Cancel"], cancelButtonIndex: 1, destructiveButtonIndex: pinned ? 0 : undefined }, (i) => {
      if (i === 0) run();
    });
  } else {
    Alert.alert(title, undefined, [{ text: label, onPress: run }, { text: "Cancel", style: "cancel" }]);
  }
}

/** Press-and-hold menu on the accessory itself: switch to another tool, or hide it. */
export function showAccessoryMenu(current: ToolId): void {
  const others = PINNABLE.filter((t) => t !== current);
  const options = [...others.map((t) => `Show ${WORKSPACE_TOOLS[t].title}`), "Hide this", "Cancel"];
  const onPick = (i: number) => {
    if (i < others.length) setPinnedTool(others[i]);
    else if (i === others.length) setPinnedTool(null);
  };
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1, destructiveButtonIndex: others.length }, onPick);
  } else {
    Alert.alert("Above the tab bar", undefined, [
      ...others.map((t, i) => ({ text: options[i], onPress: () => onPick(i) })),
      { text: "Hide this", style: "destructive" as const, onPress: () => onPick(others.length) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  }
}
