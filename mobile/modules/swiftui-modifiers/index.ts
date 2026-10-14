import { createModifier } from "@expo/ui/swift-ui/modifiers";

/**
 * Hides the navigation bar of the view's enclosing navigation column
 * (SwiftUI `.toolbar(.hidden, for: .navigationBar)`). Used on iPad, where the
 * buttons move into the native stack header that shares the floating tab
 * bar's row instead of sitting in a bar below it.
 */
export const navigationBarHidden = (hidden = true) => createModifier("navigationBarHidden", { hidden });

/**
 * While `enabled`, SwiftUI treats the view as compact width (`.environment(\.horizontalSizeClass,
 * .compact)`), so a `NavigationSplitView` collapses to one column even though the
 * window is regular width. For windows too narrow for the columns — the unfolded
 * iPhone Duo in portrait (~669pt). The value toggles without remounting.
 */
export const forceCompactWidth = (enabled = true) => createModifier("forceCompactWidth", { enabled });

/**
 * `forceCompactWidth`, decided natively: SwiftUI measures the view's own width and forces
 * compact below `threshold` points, so a fold/unfold (or Split View resize) collapses and
 * expands in the same layout pass instead of waiting for the JS window width.
 */
export const forceCompactBelow = (threshold = 700) => createModifier("forceCompactBelow", { threshold });
