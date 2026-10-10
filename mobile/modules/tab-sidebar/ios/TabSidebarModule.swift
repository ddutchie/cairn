import ExpoModulesCore
import UIKit

/// iPad tab sidebar groups — Mail-style. react-native-screens builds its tab
/// bar from plain view controllers, so the sidebar can only list the tabs flat.
/// This module rebuilds the controller's `tabs` with UIKit's tab API, turning
/// one tab into a `UITabGroup` with sidebar-only children (e.g. projects).
/// Children have no view controller, so selecting one keeps showing the
/// group's (the original tab's) screen — react-native-screens sees an ordinary
/// selection of that tab — and the child's id is reported to JS. A child may
/// have children of its own (a project's views), shown as a nested group.
public class TabSidebarModule: Module {
  private var groupIndex = 0
  private var items: [[String: Any]] = []
  private var selectedPath: [String] = []
  private var proxy: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("TabSidebar")

    Events("onSelectItem")

    /// `items`: [{ id, title, icon?, children?: [{ id, title, icon? }] }]
    /// shown under tab `index`; `selectedPath`: ids of the selected row, e.g.
    /// [projectId, "board"]. A row's reported id is its path joined by "/".
    /// Resolves true once the group is in the sidebar, false where it can't be
    /// (not an iPad, iPadOS < 18, no tab bar controller found) — JS then falls
    /// back to its own panel.
    AsyncFunction("setGroup") { (index: Int, items: [[String: Any]], selectedPath: [String], promise: Promise) in
      let changed = index != self.groupIndex || !(items as NSArray).isEqual(to: self.items)
      self.groupIndex = index
      self.items = items
      self.selectedPath = selectedPath
      DispatchQueue.main.async {
        if changed || !self.isInstalled() {
          self.apply(attempt: 0) { promise.resolve($0) }
        } else {
          self.highlight()
          promise.resolve(true)
        }
      }
    }
  }

  private weak var groupRef: AnyObject?
  private weak var tabBarController: UITabBarController?

  /// False when react-native-screens has since reset its tabs (or we never ran).
  private func isInstalled() -> Bool {
    guard #available(iOS 18.0, *), let group = groupRef as? UITabGroup, let tbc = tabBarController else { return false }
    return tbc.tabs.contains { $0 === group }
  }

  /// Highlights the selected row: while the group's tab is showing, the row
  /// itself is selected (it has no screen, so the tab's screen stays).
  private func highlight() {
    guard #available(iOS 18.0, *), let root = groupRef as? UITabGroup, let tbc = tabBarController else { return }
    var group = root
    var path: [String] = []
    var leaf: UITab?
    for id in selectedPath {
      path.append(id)
      let childId = Self.childPrefix + path.joined(separator: "/")
      group.defaultChildIdentifier = childId
      leaf = group.children.first { $0.identifier == childId }
      guard let next = leaf as? UITabGroup else { break }
      group = next
    }
    guard let leaf, tbc.selectedTab !== leaf, Self.isWithin(tbc.selectedTab, root) else { return }
    tbc.selectedTab = leaf
  }

  @available(iOS 18.0, *)
  private static func isWithin(_ tab: UITab?, _ root: UITab) -> Bool {
    var current = tab
    while let t = current {
      if t === root { return true }
      current = t.parent
    }
    return false
  }

  private func apply(attempt: Int, done: @escaping (Bool) -> Void) {
    guard #available(iOS 18.0, *), UIDevice.current.userInterfaceIdiom == .pad else { return done(false) }
    guard let tbc = Self.findTabBarController(), let vcs = tbc.viewControllers, groupIndex < vcs.count else {
      // The tab host mounts after the first JS render; try again shortly.
      if attempt < 20 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.apply(attempt: attempt + 1, done: done) }
      } else {
        done(false)
      }
      return
    }
    install(on: tbc, vcs: vcs)
    done(isInstalled())
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
        let children = items.map { Self.row($0, parent: []) }
        let group = UITabGroup(title: item?.title ?? "", image: item?.image, identifier: id, children: children) { _ in vc }
        groupRef = group
        tabBarController = tbc
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

    // Wrap the existing delegate (react-native-screens' controller) to hear
    // about child rows; everything else is forwarded to it untouched.
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

  /// A sidebar-only row; with children it becomes a collapsible nested group.
  @available(iOS 18.0, *)
  private static func row(_ it: [String: Any], parent: [String]) -> UITab {
    let path = parent + [it["id"] as? String ?? ""]
    let identifier = childPrefix + path.joined(separator: "/")
    let title = it["title"] as? String ?? ""
    let image = UIImage(systemName: it["icon"] as? String ?? "folder")
    let tab: UITab
    if let children = it["children"] as? [[String: Any]], !children.isEmpty {
      tab = UITabGroup(
        title: title,
        image: image,
        identifier: identifier,
        children: children.map { row($0, parent: path) },
        viewControllerProvider: nil
      )
    } else {
      tab = UITab(title: title, image: image, identifier: identifier, viewControllerProvider: nil)
    }
    tab.preferredPlacement = .sidebarOnly
    tab.badgeValue = it["badge"] as? String
    return tab
  }

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
    }
    return true
  }
}
