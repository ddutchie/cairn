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
    }

    OnDestroy {
      ViewModifierRegistry.unregister("navigationBarHidden")
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
