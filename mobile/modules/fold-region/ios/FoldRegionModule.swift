import ExpoModulesCore
import UIKit

/// Exposes the active *division* `ReservedRegion` of the current scene's window —
/// the real crease of an iPhone Duo (iOS 27.1 `UIView.reservedRegions(kind:)`),
/// in window coordinates. Queried through the Objective-C runtime (selectors +
/// KVC) rather than Swift symbols, so the module compiles on any Xcode and simply
/// reports `supported: false` on an OS/SDK without the API.
public class FoldRegionModule: Module {
  private var probe: RegionProbe?
  private var observers: [NSObjectProtocol] = []
  private var lastFrame: [Double]?
  private var observing = false

  public func definition() -> ModuleDefinition {
    Name("FoldRegion")

    Events("onDivisionRegionChange")

    /// `{ supported, frame: [x, y, width, height] | null }`. `frame` is null when
    /// there is no active division region (flat, outer display, or a Split View
    /// window that doesn't touch the crease).
    Function("getDivisionRegion") { () -> [String: Any] in
      Self.onMain { Self.payload(Self.activeWindow()) }
    }

    OnStartObserving {
      Self.onMain { self.startObserving() }
    }

    OnStopObserving {
      Self.onMain { self.stopObserving() }
    }

    OnDestroy {
      Self.onMain { self.stopObserving() }
    }
  }

  // MARK: Observation

  private func startObserving() {
    guard !observing else { return }
    observing = true
    let nc = NotificationCenter.default
    for name in [UIWindow.didBecomeKeyNotification, UIScene.didActivateNotification, UIScene.willEnterForegroundNotification] {
      observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.attachProbe()
      })
    }
    attachProbe()
  }

  private func stopObserving() {
    guard observing else { return }
    observing = false
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    probe?.removeFromSuperview()
    probe = nil
    lastFrame = nil
  }

  /// A transparent, full-window, touch-transparent view whose `updateProperties()`
  /// (observation-tracked: UIKit re-runs it when the regions it read change) and
  /// `layoutSubviews()` (window resized) re-publish the region.
  private func attachProbe() {
    guard observing, let window = Self.activeWindow() else { return }
    if let probe, probe.window === window { publishIfChanged(); return }
    probe?.removeFromSuperview()
    let p = RegionProbe(frame: window.bounds)
    p.onChange = { [weak self] in self?.publishIfChanged() }
    window.addSubview(p)
    probe = p
    publishIfChanged()
  }

  private func publishIfChanged() {
    let payload = Self.payload(Self.activeWindow())
    let frame = payload["frame"] as? [Double]
    guard frame != lastFrame else { return }
    lastFrame = frame
    sendEvent("onDivisionRegionChange", payload)
  }

  // MARK: Query

  static func onMain<T>(_ work: () -> T) -> T {
    Thread.isMainThread ? work() : DispatchQueue.main.sync(execute: work)
  }

  /// The key window of the foreground scene (the one that is on screen).
  static func activeWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene =
      scenes.first { $0.activationState == .foregroundActive }
      ?? scenes.first { $0.activationState == .foregroundInactive }
      ?? scenes.first
    return scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first
  }

  static func payload(_ window: UIWindow?) -> [String: Any] {
    guard let window, let frame = divisionFrame(in: window) else {
      return ["supported": supportsReservedRegions(window), "frame": NSNull()]
    }
    return [
      "supported": true,
      "frame": [Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height)],
    ]
  }

  private static let regionsSelector = NSSelectorFromString("reservedRegionsOfKind:")
  private static let divisionKindSelector = NSSelectorFromString("divisionRegionKind")

  static func supportsReservedRegions(_ window: UIWindow?) -> Bool {
    guard let window, let kind = NSClassFromString("UIViewReservedRegionKind") else { return false }
    return window.responds(to: regionsSelector) && kind.responds(to: divisionKindSelector)
  }

  /// Frame (incl. the region's margins) of the first active division region, in
  /// `window` coordinates; nil when none is active.
  static func divisionFrame(in window: UIWindow) -> CGRect? {
    guard supportsReservedRegions(window),
      let kindClass = NSClassFromString("UIViewReservedRegionKind") as AnyObject?,
      let kind = kindClass.perform(divisionKindSelector)?.takeUnretainedValue(),
      let regions = window.perform(regionsSelector, with: kind)?.takeUnretainedValue() as? [NSObject]
    else { return nil }
    for region in regions {
      if let active = region.value(forKey: "active") as? Bool, !active { continue }
      if let rect = (region.value(forKey: "frame") as? NSValue)?.cgRectValue { return rect }
    }
    return nil
  }
}

final class RegionProbe: UIView {
  var onChange: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    onChange?()
  }

  /// Reading the regions here makes UIKit invalidate (and re-run) this method when
  /// they change — pose changes that leave the window size untouched.
  @available(iOS 26.0, *)
  override func updateProperties() {
    super.updateProperties()
    if let window { _ = FoldRegionModule.divisionFrame(in: window) }
    onChange?()
  }
}
