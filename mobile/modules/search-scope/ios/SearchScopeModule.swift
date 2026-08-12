import ExpoModulesCore
import UIKit

/// Native UISearchController scope bar for the search screen.
///
/// react-native-screens renders the header search bar as a `UISearchController`,
/// but `scopeButtonTitles` is NOT one of the props it exposes, so we drive the
/// real UIKit scope bar directly: this module locates the active screen's search
/// controller (its `UINavigationItem.searchController`), sets
/// `scopeButtonTitles` / `selectedScopeButtonIndex`, and reports scope taps back
/// to JS.
///
/// UIKit owns all the animation/layout of the scope bar (it slides in/out with
/// the search field's focus state and the header height animates with it), which
/// is exactly the native behaviour we want — a JS overlay can't track those
/// transitions.
///
/// The delegate chain: react-native-screens' `RNSSearchBar` sets itself as
/// `searchBar.delegate`. We install a `SearchBarDelegateProxy` that forwards
/// every `UISearchBarDelegate` message to the original (so text input etc. keeps
/// working) while intercepting `selectedScopeButtonIndexDidChange` for JS.
public class SearchScopeModule: Module {
  private var proxy: SearchBarDelegateProxy?

  public func definition() -> ModuleDefinition {
    Name("SearchScope")

    // Fired when the user taps a scope segment: { "index": Int }.
    Events("scopeSelected")

    // Attach scope titles to the ACTIVE search controller's search bar. Returns
    // false when no search controller is active yet (the header config may not
    // have applied when the screen just mounted — the JS caller retries on the
    // next frame). Runs on the main actor: all UIKit work must be on main.
    AsyncFunction("setScope") { (titles: [String], selectedIndex: Int) -> Bool in
      await MainActor.run {
        guard let sc = self.activeSearchController() else { return false }
        sc.searchBar.scopeButtonTitles = titles
        sc.searchBar.selectedScopeButtonIndex = selectedIndex
        self.wireDelegateProxy(on: sc)
        return true
      }
    }

    // Update the selected segment without touching the titles (used when the
    // JS filter changes programmatically, e.g. via the fallback control).
    AsyncFunction("setSelectedIndex") { (index: Int) -> Void in
      await MainActor.run {
        self.activeSearchController()?.searchBar.selectedScopeButtonIndex = index
      }
    }

    // Remove the scope bar (called when the search screen loses focus so a
    // different screen's search bar never inherits stale titles).
    AsyncFunction("clear") { () -> Void in
      await MainActor.run {
        self.activeSearchController()?.searchBar.scopeButtonTitles = nil
        self.proxy = nil
      }
    }

    // Synchronous probe: is there an active search controller right now? Lets
    // the JS layer decide between the native scope bar and its fallback without
    // waiting on a promise. Read-only — safe to run off-main.
    Function("isSearchActive") { () -> Bool in
      self.activeSearchController() != nil
    }
  }

  // ── Finding the active search controller ──────────────────────────────────
  // The search screen is the top of its tab's native stack; react-native-screens
  // attaches the UISearchController to the top view controller's navigationItem.
  private func activeSearchController() -> UISearchController? {
    // Split the window lookup into two guard-let bindings: optional chaining
    // across a continuation line (`?.windows`) parses as a ternary and fails to
    // compile.
    guard
      let scene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState == .foregroundActive }),
      let window = scene.windows.first(where: { $0.isKeyWindow })
    else {
      return nil
    }

    var vc = window.rootViewController
    while let presented = vc?.presentedViewController {
      vc = presented
    }
    if let nav = vc as? UINavigationController {
      return nav.topViewController?.navigationItem.searchController
    }
    if let tab = vc as? UITabBarController {
      return tab.selectedViewController?.navigationItem.searchController
    }
    return vc?.navigationItem.searchController
  }

  /// Wrap the search bar's current delegate in a forwarding proxy (once), so
  /// scope taps reach JS without breaking react-native-screens' own delegate
  /// handling. If react-native-screens later re-applies its delegate (header
  /// config updates), the next `setScope` call re-wraps it.
  private func wireDelegateProxy(on sc: UISearchController) {
    if let current = sc.searchBar.delegate, current is SearchBarDelegateProxy {
      return
    }
    let proxy = SearchBarDelegateProxy(original: sc.searchBar.delegate) { [weak self] index in
      self?.sendEvent("scopeSelected", ["index": index])
    }
    sc.searchBar.delegate = proxy
    self.proxy = proxy
  }
}

/// Forwards every `UISearchBarDelegate` message to the original delegate
/// (react-native-screens' `RNSSearchBar`) via Objective-C message forwarding,
/// while handling `selectedScopeButtonIndexDidChange` itself to emit JS events.
private final class SearchBarDelegateProxy: NSObject, UISearchBarDelegate {
  private let original: UISearchBarDelegate?
  private let onScopeChange: (Int) -> Void

  init(original: UISearchBarDelegate?, onScopeChange: @escaping (Int) -> Void) {
    self.original = original
    self.onScopeChange = onScopeChange
    super.init()
  }

  override func responds(to aSelector: Selector!) -> Bool {
    if aSelector == #selector(UISearchBarDelegate.searchBar(_:selectedScopeButtonIndexDidChange:)) {
      return true
    }
    return original?.responds(to: aSelector) ?? false
  }

  override func forwardingTarget(for aSelector: Selector!) -> Any? {
    // We handle scope selection ourselves; everything else goes to the original.
    if aSelector == #selector(UISearchBarDelegate.searchBar(_:selectedScopeButtonIndexDidChange:)) {
      return nil
    }
    return original
  }

  func searchBar(_ searchBar: UISearchBar, selectedScopeButtonIndexDidChange selectedScope: Int) {
    onScopeChange(selectedScope)
  }
}
