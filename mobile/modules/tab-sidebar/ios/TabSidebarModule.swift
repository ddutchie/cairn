import ExpoModulesCore
import UIKit

/// iPad tab sidebar groups — Mail-style. react-native-screens builds its tab
/// bar from plain view controllers, so the sidebar can only list the tabs flat.
/// This module rebuilds the controller's `tabs` with UIKit's tab API, turning
/// one tab into a `UITabGroup` with sidebar-only children (e.g. projects).
/// Children have no view controller, so selecting one keeps showing the
/// group's (the original tab's) screen — react-native-screens sees an ordinary
/// selection of that tab — and the child's id is reported to JS.
public class TabSidebarModule: Module {
  private var groupIndex = 0
  private var items: [[String: String]] = []
  private var selectedId: String?
  private var proxy: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("TabSidebar")

    Events("onSelectItem")

    /// `items`: [{ id, title, icon? }] shown under tab `index` in the sidebar.
    Function("setGroup") { (index: Int, items: [[String: String]], selectedId: String?) in
      let changed = index != self.groupIndex || items != self.items
      self.groupIndex = index
      self.items = items
      self.selectedId = selectedId
      DispatchQueue.main.async {
        if changed || self.groupRef == nil { self.apply(attempt: 0) } else { self.highlight() }
      }
    }
  }

  private weak var groupRef: AnyObject?
  @available(iOS 18.0, *)
  private var group: UITabGroup? { groupRef as? UITabGroup }

  /// Marks the selected row in the sidebar (the group's view is unchanged).
  private func highlight() {
    guard #available(iOS 18.0, *), let group, let selectedId else { return }
    group.defaultChildIdentifier = Self.childPrefix + selectedId
  }

  private func apply(attempt: Int) {
    guard #available(iOS 18.0, *), UIDevice.current.userInterfaceIdiom == .pad else { return }
    guard let tbc = Self.findTabBarController(), let vcs = tbc.viewControllers, groupIndex < vcs.count else {
      // The tab host mounts after the first JS render; try again shortly.
      if attempt < 20 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.apply(attempt: attempt + 1) }
      }
      return
    }
    install(on: tbc, vcs: vcs)
  }

  @available(iOS 18.0, *)
  private func install(on tbc: UITabBarController, vcs: [UIViewController]) {
    let selected = tbc.selectedViewController
    // Tabs from an earlier install (or UIKit's own, built from the view
    // controllers), minus our group, so they're reused rather than rebuilt.
    let existingTabs = tbc.tabs.filter { !($0 is UITabGroup) }
    var tabs: [UITab] = []
    for (i, vc) in vcs.enumerated() {
      let item = vc.tabBarItem
      let id = "tab-\(i)"
      if i == groupIndex {
        let children: [UITab] = items.map { it in
          let child = UITab(
            title: it["title"] ?? "",
            image: UIImage(systemName: it["icon"] ?? "folder"),
            identifier: Self.childPrefix + (it["id"] ?? ""),
            viewControllerProvider: nil
          )
          child.preferredPlacement = .sidebarOnly
          return child
        }
        let group = UITabGroup(title: item?.title ?? "", image: item?.image, identifier: id, children: children) { _ in vc }
        groupRef = group
        tabs.append(group)
      } else if let existing = existingTabs.first(where: { $0.viewController === vc }) {
        // Keep UIKit's own tab (e.g. the search tab's special placement).
        tabs.append(existing)
      } else if Self.isSearch(item) {
        tabs.append(UISearchTab { _ in vc })
      } else {
        tabs.append(UITab(title: item?.title ?? "", image: item?.image, identifier: id) { _ in vc })
      }
    }

    // Child rows are reported, never selected: wrap the existing delegate
    // (react-native-screens' controller) and veto them.
    if !(tbc.delegate is SidebarDelegateProxy) {
      let proxy = SidebarDelegateProxy(inner: tbc.delegate) { [weak self] id in
        self?.sendEvent("onSelectItem", ["id": id])
      }
      self.proxy = proxy
      tbc.delegate = proxy
    }

    tbc.setTabs(tabs, animated: false)
    if let selected { tbc.selectedViewController = selected }
    highlight()
  }

  static let childPrefix = "sidebar-item:"

  /// react-native-screens marks the search tab with the system search item.
  private static func isSearch(_ item: UITabBarItem?) -> Bool {
    guard let item else { return false }
    let search = UITabBarItem(tabBarSystemItem: .search, tag: 0)
    return item.title == search.title
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

/// Forwards every delegate call to react-native-screens, and reports the
/// selection of a sidebar child row.
final class SidebarDelegateProxy: NSObject, UITabBarControllerDelegate {
  private weak var inner: UITabBarControllerDelegate?
  private let onItem: (String) -> Void

  init(inner: UITabBarControllerDelegate?, onItem: @escaping (String) -> Void) {
    self.inner = inner
    self.onItem = onItem
  }

  override func responds(to aSelector: Selector!) -> Bool {
    super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
  }

  override func forwardingTarget(for aSelector: Selector!) -> Any? {
    inner?.responds(to: aSelector) == true ? inner : nil
  }

  @available(iOS 18.0, *)
  func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
    if tab.identifier.hasPrefix(TabSidebarModule.childPrefix) {
      onItem(String(tab.identifier.dropFirst(TabSidebarModule.childPrefix.count)))
      return true
    }
    return true
  }
}
