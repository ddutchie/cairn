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
  /// The search bar the proxy is currently installed on. Retained independent
  /// of the active search controller so `clear` can always unwire the bar we
  /// configured, even after the search screen (and its controller) has gone.
  private var configuredSearchBar: UISearchBar?

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
        // iOS 26+ shows/hides the scope bar per `scopeBarActivation`. We want it
        // to appear when the search becomes active (Apple-Music behaviour) and
        // dismiss on cancel. Note: UIKit has a bug where this NEVER renders with
        // integrated/automatic search-bar placement on iPhone — the search screen
        // therefore uses `placement: "stacked"`.
        if #available(iOS 26.0, *) {
          sc.scopeBarActivation = .onSearchActivation
        }
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
    // different screen's search bar never inherits stale titles). Operates on
    // the search bar we configured (stored when the proxy was installed), NOT
    // the currently-active controller — the search screen may already be gone
    // by the time this runs, and clearing must still unwire its proxy.
    AsyncFunction("clear") { () -> Void in
      await MainActor.run {
        guard let bar = self.configuredSearchBar else { return }
        bar.scopeButtonTitles = nil
        // Unwire the delegate proxy and hand the search bar back to
        // react-native-screens' original delegate.
        if let proxy = self.proxy, bar.delegate === proxy {
          bar.delegate = proxy.originalDelegate
        }
        self.proxy = nil
        self.configuredSearchBar = nil
      }
    }

    // Synchronous probe: is there an active search controller right now? Lets
    // the JS layer decide between the native scope bar and its fallback without
    // waiting on a promise. All UIApplication / UIWindowScene / UINavigationItem
    // access must happen on the main thread — hop over synchronously (the sync
    // Function runs on the JS thread, so this can't deadlock).
    Function("isSearchActive") { () -> Bool in
      var found = false
      if Thread.isMainThread {
        found = self.activeSearchController() != nil
      } else {
        DispatchQueue.main.sync { found = self.activeSearchController() != nil }
      }
      return found
    }
  }

  // ── Finding the active search controller ──────────────────────────────────
  // The search screen is nested inside expo-router's hierarchy: root stack →
  // tab bar → per-tab stack → screen. react-native-screens attaches the
  // UISearchController to the screen's UINavigationItem, so we walk the whole
  // view-controller tree (nav stacks, tab bars, presented modals, children)
  // looking for a navigationItem that carries one.
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
    return findSearchController(from: window.rootViewController)
  }

  private func findSearchController(from vc: UIViewController?) -> UISearchController? {
    guard let vc else { return nil }
    if let sc = vc.navigationItem.searchController { return sc }
    // Presented modals (e.g. a sheet over the tab bar) can sit in front of the
    // search screen — check them first so a presented controller isn't skipped
    // when its presenter's own branch comes up empty. Only return when the
    // recursive result is non-nil; otherwise keep checking the other branches.
    if let presented = vc.presentedViewController {
      if let sc = findSearchController(from: presented) { return sc }
    }
    // Native navigation / tab containers: descend into their active child.
    if let nav = vc as? UINavigationController, let top = nav.topViewController {
      if let sc = findSearchController(from: top) { return sc }
    }
    if let tab = vc as? UITabBarController, let selected = tab.selectedViewController {
      if let sc = findSearchController(from: selected) { return sc }
    }
    // react-native-screens nests screens as child view controllers.
    for child in vc.children {
      if let sc = findSearchController(from: child) { return sc }
    }
    return nil
  }

  /// Wrap the search bar's current delegate in a forwarding proxy (once), so
  /// scope taps reach JS without breaking react-native-screens' own delegate
  /// handling. If react-native-screens later re-applies its delegate (header
  /// config updates), the next `setScope` call re-wraps it.
  private func wireDelegateProxy(on sc: UISearchController) {
    if let current = sc.searchBar.delegate, current is SearchBarDelegateProxy {
      return
    }
    let proxy = SearchBarDelegateProxy(originalDelegate: sc.searchBar.delegate) { [weak self] index in
      self?.sendEvent("scopeSelected", ["index": index])
    }
    sc.searchBar.delegate = proxy
    self.proxy = proxy
    self.configuredSearchBar = sc.searchBar
  }
}

/// Forwards every `UISearchBarDelegate` message to the original delegate
/// (react-native-screens' `RNSSearchBar`) via Objective-C message forwarding,
/// while handling `selectedScopeButtonIndexDidChange` itself to emit JS events.
private final class SearchBarDelegateProxy: NSObject, UISearchBarDelegate {
  let originalDelegate: UISearchBarDelegate?
  private let onScopeChange: (Int) -> Void

  init(originalDelegate: UISearchBarDelegate?, onScopeChange: @escaping (Int) -> Void) {
    self.originalDelegate = originalDelegate
    self.onScopeChange = onScopeChange
    super.init()
  }

  override func responds(to aSelector: Selector!) -> Bool {
    if aSelector == #selector(UISearchBarDelegate.searchBar(_:selectedScopeButtonIndexDidChange:)) {
      return true
    }
    return originalDelegate?.responds(to: aSelector) ?? super.responds(to: aSelector)
  }

  override func forwardingTarget(for aSelector: Selector!) -> Any? {
    // We handle scope selection ourselves; everything else goes to the original.
    if aSelector == #selector(UISearchBarDelegate.searchBar(_:selectedScopeButtonIndexDidChange:)) {
      return nil
    }
    return originalDelegate
  }

  func searchBar(_ searchBar: UISearchBar, selectedScopeButtonIndexDidChange selectedScope: Int) {
    onScopeChange(selectedScope)
  }
}
