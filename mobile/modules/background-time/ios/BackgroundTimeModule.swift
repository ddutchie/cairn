import ExpoModulesCore
import UIKit

/// Wraps `UIApplication.beginBackgroundTask`: asks iOS to keep the app running
/// for a short while after it's backgrounded, so work already in flight (the
/// background sync's oplog write) can finish instead of being suspended halfway.
///
/// `begin` is synchronous on purpose: it must run inside the background
/// transition, before iOS suspends the process. It returns a token (0 when iOS
/// refuses), which `end` releases. When iOS's allowance runs out, the
/// expiration handler releases the task itself, as UIKit requires.
public class BackgroundTimeModule: Module {
  private let lock = NSLock()
  private var tasks: [Int: UIBackgroundTaskIdentifier] = [:]
  private var nextToken = 1

  public func definition() -> ModuleDefinition {
    Name("BackgroundTime")

    Function("begin") { (name: String) -> Int in
      self.lock.lock()
      let token = self.nextToken
      self.nextToken += 1
      self.lock.unlock()

      // beginBackgroundTask is safe to call off the main thread.
      let id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
        self?.end(token)
      }
      if id == .invalid { return 0 }

      self.lock.lock()
      self.tasks[token] = id
      self.lock.unlock()
      return token
    }

    Function("end") { (token: Int) in
      self.end(token)
    }

    /// Seconds iOS will still let the app run in the background (a large
    /// number while foregrounded). For logging and tests on device.
    Function("remainingTime") { () -> Double in
      Self.onMain { UIApplication.shared.backgroundTimeRemaining }
    }
  }

  private func end(_ token: Int) {
    lock.lock()
    let id = tasks.removeValue(forKey: token)
    lock.unlock()
    if let id { UIApplication.shared.endBackgroundTask(id) }
  }

  private static func onMain<T>(_ work: () -> T) -> T {
    if Thread.isMainThread { return work() }
    return DispatchQueue.main.sync(execute: work)
  }
}
