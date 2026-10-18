import ExpoModulesCore
import ExpoUI
import SwiftUI
import UIKit

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
      VerticalBarOptOut.install()
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
    /// targets the container that owns the rail.
    /// Resolves a diagnostic dict: { ok, reason?, controller?, screens? } —
    /// TEMP-DIAG shape, narrowed once the rail responds.
    AsyncFunction("preferTabBarCompression") { (promise: Promise) in
      DispatchQueue.main.async {
        guard #available(iOS 27.1, *) else { promise.resolve(["ok": false, "reason": "old-ios"] as [String: Any]); return }
        guard let tbc = Self.findTabBarController() else { promise.resolve(["ok": false, "reason": "no-tbc"] as [String: Any]); return }
        var screens: [UIViewController] = []
        if let vcs = tbc.viewControllers {
          screens += vcs.flatMap(Self.allScreens)
        }
        if #available(iOS 18.0, *) {
          for tab in tbc.tabs {
            if let vc = tab.viewController, !screens.contains(where: { $0 === vc }) {
              screens += Self.allScreens(vc)
            }
          }
        }
        if screens.isEmpty {
          promise.resolve(["ok": false, "reason": "no-screens", "controller": "\(type(of: tbc))"] as [String: Any])
          return
        }
        for screen in screens {
          screen.navigationItem.verticalBarCompressionBehavior = .prefersTabBar
        }
        promise.resolve(["ok": true, "controller": "\(type(of: tbc))", "screens": screens.count, "hooked": VerticalBarOptOut.hookedClass as Any] as [String: Any])
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

/// UIKit opt-out for the Duo side rail (spike).
///
/// The folded-Duo rail is composed by the system across the tab bar
/// controller: neither the SwiftUI vertical modifiers nor the per-screen
/// `verticalBarCompressionBehavior` stamp govern it. This overrides
/// `preferredVerticalBarBehavior` on the RNScreens tab screen class to
/// return `.disabled` while vertically compact (the folded outer display /
/// landscape phones — exactly when the rail appears), falling back to the
/// system default otherwise. Trait-driven, so the system re-queries on
/// fold/rotate; wide layouts keep the rail.
enum VerticalBarOptOut {
  static var hookedClass: String?

  static func install() {
    guard #available(iOS 27.1, *), hookedClass == nil else { return }
    for name in ["RNSTabsScreenViewController"] {
      guard let cls: AnyClass = NSClassFromString(name) else { continue }
      let sel = NSSelectorFromString("preferredVerticalBarBehavior")
      let block: @convention(block) (AnyObject) -> UIVerticalBarBehavior = { obj in
        guard let vc = obj as? UIViewController else { return .automatic }
        return vc.traitCollection.verticalSizeClass == .compact ? .disabled : .automatic
      }
      // The RNScreens class doesn't implement the property itself — add (don't
      // replace) so only this subclass is affected.
      if class_addMethod(cls, sel, imp_implementationWithBlock(block as Any), "q@:") {
        hookedClass = name
        return
      }
    }
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
