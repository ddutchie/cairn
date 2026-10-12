import { createModifier } from "@expo/ui/swift-ui/modifiers";

/**
 * Hides the navigation bar of the view's enclosing navigation column
 * (SwiftUI `.toolbar(.hidden, for: .navigationBar)`). Used on iPad, where the
 * buttons move into the native stack header that shares the floating tab
 * bar's row instead of sitting in a bar below it.
 */
export const navigationBarHidden = (hidden = true) => createModifier("navigationBarHidden", { hidden });
