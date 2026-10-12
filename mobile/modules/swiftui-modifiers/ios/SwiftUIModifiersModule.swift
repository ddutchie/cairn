import ExpoModulesCore
import ExpoUI
import SwiftUI

/// Registers extra SwiftUI view modifiers with @expo/ui's modifier registry, so
/// JS can apply them through `modifiers={[...]}` like the built-in ones.
public class SwiftUIModifiersModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SwiftUIModifiers")

    OnCreate {
      ViewModifierRegistry.register("navigationBarHidden") { params, _, _ in
        NavigationBarHiddenModifier(hidden: params["hidden"] as? Bool ?? true)
      }
      ViewModifierRegistry.register("forceCompactWidth") { params, _, _ in
        ForceCompactWidthModifier(enabled: params["enabled"] as? Bool ?? true)
      }
    }

    OnDestroy {
      ViewModifierRegistry.unregister("navigationBarHidden")
      ViewModifierRegistry.unregister("forceCompactWidth")
    }
  }
}

/// `.toolbar(.hidden, for: .navigationBar)` — hides the enclosing navigation
/// column's bar (title, toolbar items and the system sidebar button).
struct NavigationBarHiddenModifier: ViewModifier {
  let hidden: Bool

  func body(content: Content) -> some View {
    content.toolbar(hidden ? .hidden : .automatic, for: .navigationBar)
  }
}

/// `.environment(\.horizontalSizeClass, .compact)` while `enabled` — makes a
/// `NavigationSplitView` collapse to one column (phone-style drill-down) in a
/// window that is regular-width but too narrow for its columns (the unfolded
/// iPhone Duo in portrait, ~669pt). Always applies the same single environment
/// modifier and only changes its value, so toggling it (rotation) never changes
/// the view's identity — the split view and its open note are not remounted.
struct ForceCompactWidthModifier: ViewModifier {
  let enabled: Bool
  @Environment(\.horizontalSizeClass) private var current

  func body(content: Content) -> some View {
    content.environment(\.horizontalSizeClass, enabled ? .compact : current)
  }
}
