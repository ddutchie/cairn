import ExpoModulesCore
import ExpoUI
import SwiftUI

/// Registers iPhone Duo vertical-bar modifiers with @expo/ui's modifier
/// registry, so JS can apply them through `modifiers={[...]}` like the
/// built-in ones. Mirrors `SwiftUIModifiersModule`.
///
/// - `toolbarVerticalBehavior(.disabled)` keeps a column's bar horizontal
///   instead of docking its buttons into the side rail (Apple: only the
///   detail column participates — sidebar/content columns opt out).
/// - `toolbarVerticalCompressionBehavior` picks which bar survives when the
///   shared rail runs out of room (toolbar-first vs tab-bar-first).
///
/// Both APIs are iOS 27.1+; below that the content renders unchanged.
public class DuoBarsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DuoBars")

    OnCreate {
      ViewModifierRegistry.register("duoToolbarVerticalBehavior") { params, _, _ in
        DuoToolbarVerticalBehaviorModifier(behavior: params["behavior"] as? String ?? "automatic")
      }
      ViewModifierRegistry.register("duoToolbarVerticalCompressionBehavior") { params, _, _ in
        DuoToolbarVerticalCompressionBehaviorModifier(behavior: params["behavior"] as? String ?? "automatic")
      }
    }

    OnDestroy {
      ViewModifierRegistry.unregister("duoToolbarVerticalBehavior")
      ViewModifierRegistry.unregister("duoToolbarVerticalCompressionBehavior")
    }

    /// Spike: engage the SYSTEM rail coordination for the tab screens. The
    /// folded-Duo rail merges the UIKit tab bar with SwiftUI column toolbars
    /// hosted inside the tab — a cross-framework mix the SwiftUI-only
    /// modifiers above don't govern. Setting the screens'
    /// `navigationItem.verticalBarCompressionBehavior = .prefersTabBar`
    /// (Apple's default: toolbar collapses into ··· first, tabs preserved)
    /// targets the container that owns the rail. Resolves the number of
    /// screens stamped, false where unavailable.
    AsyncFunction("preferTabBarCompression") { (promise: Promise) in
      DispatchQueue.main.async {
        guard #available(iOS 27.1, *) else { promise.resolve(false); return }
        guard let tbc = Self.findTabBarController(), let vcs = tbc.viewControllers else {
          promise.resolve(false)
          return
        }
        var count = 0
        for vc in vcs {
          for screen in Self.allScreens(vc) {
            screen.navigationItem.verticalBarCompressionBehavior = .prefersTabBar
            count += 1
          }
        }
        promise.resolve(count)
      }
    }
  }

  /// All content screens under a container: nav stacks, nested tabs,
  /// presented controllers.
  private static func allScreens(_ vc: UIViewController) -> [UIViewController] {
    var out: [UIViewController] = [vc]
    if let nav = vc as? UINavigationController {
      out += nav.viewControllers.flatMap(allScreens)
    } else if let tabs = vc as? UITabBarController {
      out += (tabs.viewControllers ?? []).flatMap(allScreens)
    }
    for child in vc.children where !(child is UINavigationController) && !(child is UITabBarController) {
      if !out.contains(where: { $0 === child }) { out += allScreens(child) }
    }
    if let presented = vc.presentedViewController {
      out += allScreens(presented)
    }
    return out
  }

  private static func findTabBarController() -> UITabBarController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    for window in windows {
      if let found = search(window.rootViewController) { return found }
    }
    return nil
  }

  private static func search(_ vc: UIViewController?) -> UITabBarController? {
    guard let vc else { return nil }
    if let tbc = vc as? UITabBarController { return tbc }
    for child in vc.children {
      if let found = search(child) { return found }
    }
    return search(vc.presentedViewController)
  }
}

/// `.toolbarVerticalBehavior(.automatic | .disabled)` — scoped to the view the
/// modifier is attached to (a split-view column's `Toolbar`), not the window.
struct DuoToolbarVerticalBehaviorModifier: ViewModifier {
  let behavior: String

  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      switch behavior {
      case "disabled":
        content.toolbarVerticalBehavior(.disabled)
      default:
        content.toolbarVerticalBehavior(.automatic)
      }
    } else {
      content
    }
  }
}

/// `.toolbarVerticalCompressionBehavior(.automatic | .prefersToolbarItems |
/// .prefersTabBar)` — which bar compresses first in the shared vertical rail.
struct DuoToolbarVerticalCompressionBehaviorModifier: ViewModifier {
  let behavior: String

  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      switch behavior {
      case "prefersToolbarItems":
        content.toolbarVerticalCompressionBehavior(.prefersToolbarItems)
      case "prefersTabBar":
        content.toolbarVerticalCompressionBehavior(.prefersTabBar)
      default:
        content.toolbarVerticalCompressionBehavior(.automatic)
      }
    } else {
      content
    }
  }
}
