import ExpoModulesCore
import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

// Event names emitted to JS. Each carries a `requestId` so the JS bridge can
// route to the correct in-flight generation (multiple may overlap).
private let EVENT_TOKEN = "onToken"
private let EVENT_DONE = "onDone"
private let EVENT_ERROR = "onError"
private let EVENT_TOOL_CALL = "onToolCall"

// Stable public error codes mirrored on the JS side (AppleLLMErrorCodes). Treat
// `code` as the control-flow contract; `message` is display/debug text.
private enum AppleLlmCode: String {
  case modelUnavailable = "MODEL_UNAVAILABLE"
  case unsupportedOS = "UNSUPPORTED_OS"
  case generationError = "GENERATION_ERROR"
  case invalidMessage = "INVALID_MESSAGE"
  case invalidSchema = "INVALID_SCHEMA"
  case toolCallError = "TOOL_CALL_ERROR"
  case contextWindowExceeded = "CONTEXT_WINDOW_EXCEEDED"
  case cancelled = "CANCELLED"
  // Private Cloud Compute: the user hit their daily request quota. Distinct from
  // rate limiting — they wait for the reset date or upgrade iCloud+.
  case quotaExceeded = "QUOTA_EXCEEDED"
  // PCC request failed with no network (PCC is online-only). JS retries on-device.
  case networkUnavailable = "NETWORK_UNAVAILABLE"
}

/// A tool the model may call, mirrored from Cairn's AiTool. `jsonSchema` is a
/// JSON-encoded string of the arguments' JSON Schema (passed as a string to
/// avoid `[String: Any]` Record-bridging quirks; parsed natively).
struct AppleLlmTool: Record {
  @Field var name: String = ""
  @Field var description: String = ""
  @Field var jsonSchema: String = "{}"
}

/// Generation tuning knobs. Mirrors the JS `AppleGenerateOptions`.
struct AppleLlmOptions: Record {
  @Field var temperature: Double?
  @Field var maxTokens: Int?
  @Field var system: String?
  /// Route this session through Private Cloud Compute (server model, iOS 27+)
  /// instead of the on-device model. Falls back to on-device below iOS 27.
  @Field var useServer: Bool = false
  /// PCC reasoning effort: "light" | "moderate" | "deep". Ignored on-device and
  /// when nil (uses the model default). Deeper reasoning trades latency + more
  /// of the 32K window for stronger multi-step analysis.
  @Field var reasoningLevel: String?
}

public class AppleLlmModule: Module {
  // In-flight streaming tasks by requestId so `cancel` can stop them.
  private var tasks: [String: Task<Void, Never>] = [:]
  // Persistent per-thread sessions keyed by a JS-provided sessionId. Reusing a
  // session lets FoundationModels keep the transcript natively (better grounding,
  // fewer tokens than re-sending history). A new chat → resetSession → fresh
  // 4096-token window. Stored as AnyObject because the concrete type is
  // iOS-26-only; access is always `@available`-gated and cast back.
  private var sessionStore: [String: AnyObject] = [:]
  // Serialises access to `tasks` and `sessionStore`, which are touched from
  // Expo function callbacks, event callbacks, and the unstructured streaming
  // Task. Mirrors ToolBridge's NSLock approach.
  private let stateLock = NSLock()
  // Sendable bridge that owns tool-call continuations and forwards calls to JS.
  // Shared across requests (callIds are globally unique). Created lazily once the
  // module can emit events.
  private lazy var toolBridge = ToolBridge { [weak self] payload in
    self?.sendEvent(EVENT_TOOL_CALL, payload)
  }

  public func definition() -> ModuleDefinition {
    Name("AppleLlm")

    Events(EVENT_TOKEN, EVENT_DONE, EVENT_ERROR, EVENT_TOOL_CALL)

    // Synchronous availability probe. False on simulators, non-Apple-Intelligence
    // devices, and anything below iOS 26. Safe to call on any OS.
    Function("isAvailable") { () -> Bool in
      return Self.availabilityState().available
    }

    // Human-readable reason when unavailable (for the settings UI). Empty when
    // available.
    Function("unavailableReason") { () -> String in
      return Self.availabilityState().reason
    }

    // Whether Private Cloud Compute (the server model) can serve requests right
    // now: iOS 27+, an Apple-Intelligence-eligible device, and PCC ready. False
    // everywhere else (older OS, ineligible device, simulator).
    Function("isServerAvailable") { () -> Bool in
      return Self.serverAvailabilityState().available
    }

    // Human-readable reason PCC is unavailable (empty when available).
    Function("serverUnavailableReason") { () -> String in
      return Self.serverAvailabilityState().reason
    }

    // Current PCC daily-quota snapshot as a JSON string, so the JS/UI can show a
    // usage indicator and an iCloud+ upgrade path. Fields:
    //   { available: Bool, status: "below"|"approaching"|"exceeded"|"unknown",
    //     isLimitReached: Bool, canUpgrade: Bool, resetDate: String? (ISO8601) }
    // `available:false` when PCC/iOS 27 isn't present — callers should hide the UI.
    Function("quotaStatus") { () -> String in
      return Self.quotaStatusJson()
    }

    // Present Apple's system iCloud+ upgrade sheet when the user is at/near quota.
    // No-op when PCC is unavailable or no upgrade suggestion exists. Best-effort.
    Function("showQuotaUpgradeOptions") { () -> Bool in
      return Self.showQuotaUpgrade()
    }

    // Token count of a plain string via the on-device tokenizer (iOS 26.4+).
    // Returns -1 when unavailable. Usage for the context ring is reported on the
    // onDone event; this stays for ad-hoc counts.
    AsyncFunction("countTokens") { (text: String) -> Int in
      #if canImport(FoundationModels)
      if #available(iOS 26.4, *) {
        return (try? await SystemLanguageModel.default.tokenCount(for: text)) ?? -1
      }
      #endif
      return -1
    }

    // Start a streaming generation on the persistent session `sessionId`. The
    // session keeps the transcript, so `prompt` is just the newest user turn.
    // Tokens arrive via `onToken`, tool calls via `onToolCall` (answer with
    // `resolveToolCall`), completion via `onDone` / `onError`, keyed by requestId.
    AsyncFunction("generate") { (requestId: String, sessionId: String, prompt: String, tools: [AppleLlmTool], options: AppleLlmOptions) in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        self.startGeneration(requestId: requestId, sessionId: sessionId, prompt: prompt, tools: tools, options: options)
        return
      }
      #endif
      self.emitError(requestId, .unsupportedOS, "Apple Foundation Models requires iOS 26 or newer.")
    }

    // Drop a persistent session (e.g. when the user clears the chat) so the next
    // generate() starts a fresh context window. Clears both the on-device and
    // PCC variants for the thread (sessions are namespaced by model kind).
    Function("resetSession") { (sessionId: String) in
      self.withState {
        $0.sessionStore.removeValue(forKey: "device:" + sessionId)
        $0.sessionStore.removeValue(forKey: "server:" + sessionId)
      }
    }

    // Warm the model for a session to reduce first-token latency. Best-effort.
    Function("prewarm") { (sessionId: String, system: String?, tools: [AppleLlmTool], useServer: Bool) in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        let server = useServer && Self.serverAvailabilityState().available
        if let session = try? self.ensureSession(sessionId: sessionId, system: system, tools: tools, useServer: server) {
          session.prewarm()
        }
      }
      #endif
    }

    // Resume a suspended tool call with its JSON result (or an error message).
    // Called by JS after it executes the tool locally.
    Function("resolveToolCall") { (callId: String, resultJson: String, errorMessage: String?) in
      self.toolBridge.resolve(callId: callId, resultJson: resultJson, errorMessage: errorMessage)
    }

    // Cancel an in-flight generation.
    Function("cancel") { (requestId: String) in
      self.cancelTask(requestId)
    }

    OnDestroy {
      let pendingTasks = self.withState { s -> [Task<Void, Never>] in
        let all = Array(s.tasks.values)
        s.tasks.removeAll()
        s.sessionStore.removeAll()
        return all
      }
      for task in pendingTasks { task.cancel() }
      self.toolBridge.cancelAll()
    }
  }

  // MARK: - Guarded state

  /// Serialised access to `tasks` / `sessionStore`. All mutation/reads of those
  /// two dictionaries go through this so callbacks and the streaming Task can't
  /// race. The closure runs under `stateLock`.
  @discardableResult
  private func withState<T>(_ body: (AppleLlmModule) -> T) -> T {
    stateLock.lock()
    defer { stateLock.unlock() }
    return body(self)
  }

  private func storeTask(_ task: Task<Void, Never>, for requestId: String) {
    withState { $0.tasks[requestId] = task }
  }

  private func removeTask(_ requestId: String) {
    withState { _ = $0.tasks.removeValue(forKey: requestId) }
  }

  private func cancelTask(_ requestId: String) {
    let task = withState { $0.tasks.removeValue(forKey: requestId) }
    task?.cancel()
  }

  // MARK: - Availability
  private static func availabilityState() -> (available: Bool, reason: String) {
    #if canImport(FoundationModels)
    if #available(iOS 26.0, *) {
      switch SystemLanguageModel.default.availability {
      case .available:
        return (true, "")
      case .unavailable(let reason):
        return (false, Self.describe(reason))
      @unknown default:
        return (false, "Apple Intelligence is unavailable.")
      }
    }
    return (false, "Requires iOS 26 or newer.")
    #else
    return (false, "Foundation Models framework is not available in this build.")
    #endif
  }

  #if canImport(FoundationModels)
  @available(iOS 26.0, *)
  private static func describe(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
    switch reason {
    case .deviceNotEligible:
      return "This device doesn't support Apple Intelligence."
    case .appleIntelligenceNotEnabled:
      return "Turn on Apple Intelligence in Settings to use on-device AI."
    case .modelNotReady:
      return "The on-device model is still downloading. Try again shortly."
    @unknown default:
      return "Apple Intelligence is unavailable."
    }
  }
  #endif

  // MARK: - Private Cloud Compute availability + quota

  /// Whether the server (PCC) model can serve requests. Requires iOS 27+, an
  /// eligible device, and the framework reporting `.available`. Always false when
  /// built against a pre-iOS-27 SDK (PCC symbols compiled out via CAIRN_PCC_SDK).
  private static func serverAvailabilityState() -> (available: Bool, reason: String) {
    #if CAIRN_PCC_SDK
    if #available(iOS 27.0, *) {
      switch PrivateCloudComputeLanguageModel().availability {
      case .available:
        return (true, "")
      case .unavailable(.deviceNotEligible):
        return (false, "This device doesn't support Apple Intelligence.")
      case .unavailable(.systemNotReady):
        return (false, "Private Cloud Compute isn't ready yet. Try again shortly.")
      case .unavailable:
        return (false, "Private Cloud Compute is unavailable.")
      @unknown default:
        return (false, "Private Cloud Compute is unavailable.")
      }
    }
    return (false, "Requires iOS 27 or newer.")
    #else
    return (false, "Private Cloud Compute requires iOS 27 or newer.")
    #endif
  }

  /// PCC daily-quota snapshot as JSON (see the `quotaStatus` Function doc).
  private static func quotaStatusJson() -> String {
    #if CAIRN_PCC_SDK
    if #available(iOS 27.0, *) {
      let model = PrivateCloudComputeLanguageModel()
      if case .available = model.availability {
        let usage = model.quotaUsage
        var status = "unknown"
        var approaching = false
        if usage.isLimitReached {
          status = "exceeded"
        } else if case .belowLimit(let info) = usage.status {
          approaching = info.isApproachingLimit
          status = approaching ? "approaching" : "below"
        }
        let iso: String
        if let reset = usage.resetDate {
          let fmt = ISO8601DateFormatter()
          iso = fmt.string(from: reset)
        } else {
          iso = ""
        }
        let dict: [String: Any] = [
          "available": true,
          "status": status,
          "isLimitReached": usage.isLimitReached,
          "canUpgrade": usage.limitIncreaseSuggestion != nil,
          "resetDate": iso,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let json = String(data: data, encoding: .utf8) {
          return json
        }
      }
    }
    #endif
    return "{\"available\":false,\"status\":\"unknown\",\"isLimitReached\":false,\"canUpgrade\":false,\"resetDate\":\"\"}"
  }

  /// Present the system iCloud+ upgrade sheet. Returns whether a suggestion was shown.
  private static func showQuotaUpgrade() -> Bool {
    #if CAIRN_PCC_SDK
    if #available(iOS 27.0, *), case .available = PrivateCloudComputeLanguageModel().availability {
      if let suggestion = PrivateCloudComputeLanguageModel().quotaUsage.limitIncreaseSuggestion {
        suggestion.show()
        return true
      }
    }
    #endif
    return false
  }

  // MARK: - Generation

  #if canImport(FoundationModels)
  @available(iOS 26.0, *)
  private func startGeneration(requestId: String, sessionId: String, prompt: String, tools: [AppleLlmTool], options: AppleLlmOptions) {
    // Resolve the effective model kind: PCC only when requested AND actually
    // available (iOS 27 + eligible device). Otherwise fall back to on-device.
    let useServer = options.useServer && Self.serverAvailabilityState().available

    if useServer {
      // PCC availability was just checked; on-device check is skipped for server.
    } else {
      guard case .available = SystemLanguageModel.default.availability else {
        let state = Self.availabilityState()
        emitError(requestId, .modelUnavailable, state.reason.isEmpty ? "Apple Intelligence is unavailable." : state.reason)
        return
      }
    }

    let promptText = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    if promptText.isEmpty {
      emitError(requestId, .invalidMessage, "The prompt was empty.")
      return
    }

    // Reuse (or lazily create) the persistent session for this chat thread. The
    // session carries the transcript + tools + instructions across turns. The
    // cache key includes the model kind so an on-device and a PCC session for
    // the same thread never collide.
    let session: LanguageModelSession
    do {
      session = try ensureSession(sessionId: sessionId, system: options.system, tools: tools, useServer: useServer)
    } catch let e as AppleLlmSchemaError {
      if case .unsupported(let m) = e {
        emitError(requestId, .invalidSchema, "A tool schema couldn't be used by Apple Foundation Models: \(m)")
      } else {
        emitError(requestId, .invalidSchema, "Invalid tool schema.")
      }
      return
    } catch {
      emitError(requestId, .invalidSchema, "Invalid tool schema: \(error.localizedDescription)")
      return
    }

    let genOptions = GenerationOptions(
      temperature: options.temperature,
      maximumResponseTokens: options.maxTokens
    )

    let task = Task { [weak self] in
      guard let self else { return }
      var previous = ""
      do {
        let stream = Self.makeStream(
          session: session,
          prompt: promptText,
          genOptions: genOptions,
          useServer: useServer,
          reasoningLevel: options.reasoningLevel
        )
        for try await snapshot in stream {
          if Task.isCancelled {
            self.emitError(requestId, .cancelled, "Generation cancelled.")
            self.removeTask(requestId)
            return
          }
          // ResponseStream<String>.Snapshot.content is the cumulative text so
          // far (String.PartiallyGenerated == String). Emit only the new tail.
          let text = snapshot.content
          if text.count > previous.count, text.hasPrefix(previous) {
            let delta = String(text.dropFirst(previous.count))
            previous = text
            if !delta.isEmpty {
              self.sendEvent(EVENT_TOKEN, ["requestId": requestId, "delta": delta])
            }
          } else if text != previous {
            previous = text
            self.sendEvent(EVENT_TOKEN, ["requestId": requestId, "delta": text])
          }
        }
        // Report context-window usage for the ring: token count of the session
        // transcript (numerator) over the model's context size (denominator).
        // Best-effort — never fails the turn.
        let (promptTokens, contextLimit) = await Self.usage(for: session, useServer: useServer)
        self.sendEvent(EVENT_DONE, [
          "requestId": requestId,
          "finishReason": "stop",
          "promptTokens": promptTokens,
          "contextLimit": contextLimit,
        ])
        self.removeTask(requestId)
      } catch is CancellationError {
        self.emitError(requestId, .cancelled, "Generation cancelled.")
        self.removeTask(requestId)
      } catch {
        let (code, message) = Self.mapError(error, useServer: useServer)
        self.emitError(requestId, code, message)
        self.removeTask(requestId)
      }
    }
    storeTask(task, for: requestId)
  }

  /// Build the response stream, applying PCC `ContextOptions(reasoningLevel:)`
  /// when running on the server model (iOS 27+). On-device ignores reasoning.
  @available(iOS 26.0, *)
  private static func makeStream(
    session: LanguageModelSession,
    prompt: String,
    genOptions: GenerationOptions,
    useServer: Bool,
    reasoningLevel: String?
  ) -> LanguageModelSession.ResponseStream<String> {
    #if CAIRN_PCC_SDK
    if useServer, #available(iOS 27.0, *), let level = Self.reasoning(from: reasoningLevel) {
      return session.streamResponse(
        to: prompt,
        options: genOptions,
        contextOptions: ContextOptions(reasoningLevel: level)
      )
    }
    #endif
    return session.streamResponse(to: prompt, options: genOptions)
  }

  /// Context-window usage for the ring: (promptTokens, contextLimit).
  /// promptTokens = token count of the session transcript via the on-device
  /// tokenizer (iOS 26.4+); on the PCC path this is a close estimate (same
  /// tokenizer family). contextLimit = PCC contextSize (iOS 27) or the on-device
  /// 4096. Returns (-1, -1) when unavailable so JS can hide the ring. Best-effort.
  @available(iOS 26.0, *)
  private static func usage(for session: LanguageModelSession, useServer: Bool) async -> (Int, Int) {
    var promptTokens = -1
    if #available(iOS 26.4, *) {
      promptTokens = (try? await SystemLanguageModel.default.tokenCount(for: session.transcript)) ?? -1
    }

    var contextLimit = useServer ? -1 : 4096
    #if CAIRN_PCC_SDK
    if useServer, #available(iOS 27.0, *) {
      contextLimit = (try? await PrivateCloudComputeLanguageModel().contextSize) ?? -1
    }
    #endif

    return (promptTokens, contextLimit)
  }

  /// Fetch the cached session for `sessionId` (namespaced by model kind), or
  /// build one bound with the given instructions + tools. Tools/instructions are
  /// fixed at creation time (Apple's design), which is fine because Cairn's tool
  /// set and system prompt are stable for the life of a chat thread.
  ///
  /// NOTE: the initializers differ by OS. iOS 26 has
  /// `init(model: SystemLanguageModel = .default, ...)` (concrete). The unified
  /// `init(model: some LanguageModel, ...)` — needed to pass a
  /// PrivateCloudComputeLanguageModel — is iOS 27+ ONLY. So the server path uses
  /// the 27-only init under `#if CAIRN_PCC_SDK`, and the on-device path uses the
  /// 26 concrete-SystemLanguageModel init. There is no single shared init.
  @available(iOS 26.0, *)
  private func ensureSession(sessionId: String, system: String?, tools: [AppleLlmTool], useServer: Bool) throws -> LanguageModelSession {
    let cacheKey = (useServer ? "server:" : "device:") + sessionId
    if let existing = withState({ $0.sessionStore[cacheKey] }) as? LanguageModelSession {
      return existing
    }
    let bridge = self.toolBridge
    let bridgedTools: [any Tool] = try tools.map { def in
      let schemaDict = try Self.parseJsonObject(def.jsonSchema)
      let schema = try AppleLlmSchemaParser.generationSchema(from: schemaDict)
      return BridgedTool(
        name: def.name,
        description: def.description,
        parameters: schema,
        invoke: { toolName, argsJson in
          try await bridge.call(sessionId: sessionId, toolName: toolName, argumentsJson: argsJson)
        }
      )
    }
    let instructions = (system?.isEmpty == false) ? Instructions(system!) : nil

    let session: LanguageModelSession
    #if CAIRN_PCC_SDK
    if useServer, #available(iOS 27.0, *) {
      // iOS 27 unified init taking `some LanguageModel` (PCC conforms to it).
      session = LanguageModelSession(
        model: PrivateCloudComputeLanguageModel(),
        tools: bridgedTools,
        instructions: instructions
      )
    } else {
      // On-device: iOS 26 concrete-SystemLanguageModel init.
      session = LanguageModelSession(
        model: SystemLanguageModel.default,
        tools: bridgedTools,
        instructions: instructions
      )
    }
    #else
    // Built against a pre-iOS-27 SDK: on-device model only.
    session = LanguageModelSession(
      model: SystemLanguageModel.default,
      tools: bridgedTools,
      instructions: instructions
    )
    #endif

    withState { $0.sessionStore[cacheKey] = session }
    return session
  }

  /// Map a JS reasoning-level string to the FoundationModels enum (iOS 27+).
  #if CAIRN_PCC_SDK
  @available(iOS 27.0, *)
  private static func reasoning(from level: String?) -> ContextOptions.ReasoningLevel? {
    switch level?.lowercased() {
    case "light": return .light
    case "moderate": return .moderate
    case "deep": return .deep
    default: return nil
    }
  }
  #endif


  @available(iOS 26.0, *)
  private static func mapError(_ error: Error, useServer: Bool) -> (AppleLlmCode, String) {
    // Private Cloud Compute daily-quota exhaustion (iOS 27+). Checked first so
    // the JS side can steer the user to an iCloud+ upgrade instead of retrying.
    #if CAIRN_PCC_SDK
    if #available(iOS 27.0, *) {
      if let pccError = error as? PrivateCloudComputeLanguageModel.Error {
        if case .quotaLimitReached = pccError {
          return (.quotaExceeded, "You've reached your daily Private Cloud Compute limit. It resets later, or upgrade iCloud+ for more.")
        }
      }
    }
    #endif
    if let genError = error as? LanguageModelSession.GenerationError {
      switch genError {
      case .exceededContextWindowSize:
        return (.contextWindowExceeded, "The request exceeded the model's context window.")
      case .assetsUnavailable:
        return (.modelUnavailable, "The on-device model assets aren't available yet.")
      default:
        return (.generationError, genError.errorDescription ?? genError.localizedDescription)
      }
    }
    if let toolError = error as? AppleLlmToolError {
      return (.toolCallError, toolError.message)
    }
    // A PCC request with no connectivity surfaces as a URL/network error; flag it
    // so JS can retry on-device. Only PCC actually needs the network — on-device
    // generation is offline, so don't blame connectivity there.
    let ns = error as NSError
    if useServer, ns.domain == NSURLErrorDomain {
      return (.networkUnavailable, "Private Cloud Compute needs a connection. Reconnect and try again.")
    }
    return (.generationError, error.localizedDescription)
  }

  private static func parseJsonObject(_ json: String) throws -> [String: Any] {
    guard let data = json.data(using: .utf8),
          let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw AppleLlmToolError.jsError("Tool schema is not a valid JSON object.")
    }
    return obj
  }
  #endif

  private func emitError(_ requestId: String, _ code: AppleLlmCode, _ message: String) {
    sendEvent(EVENT_ERROR, ["requestId": requestId, "code": code.rawValue, "message": message])
  }
}

// MARK: - Tool bridge

enum AppleLlmToolError: Error {
  case jsError(String)
  case cancelled

  var message: String {
    switch self {
    case .jsError(let m): return m
    case .cancelled: return "Tool call cancelled."
    }
  }
}

/// Owns the suspended tool-call continuations and forwards each call to JS via
/// a Sendable event closure. `@unchecked Sendable` because access to the
/// continuation dictionary is serialised by an internal lock.
final class ToolBridge: @unchecked Sendable {
  private let emit: @Sendable (_ payload: [String: Any]) -> Void
  private var continuations: [String: CheckedContinuation<String, Error>] = [:]
  private let lock = NSLock()

  init(emit: @escaping @Sendable (_ payload: [String: Any]) -> Void) {
    self.emit = emit
  }

  /// Suspend until JS resolves this call. Emits `onToolCall` with a fresh callId.
  /// Keyed by `sessionId` (stable across turns) so the JS provider can route it;
  /// a session only ever has one active generation at a time.
  func call(sessionId: String, toolName: String, argumentsJson: String) async throws -> String {
    let callId = UUID().uuidString
    return try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      continuations[callId] = continuation
      lock.unlock()
      emit([
        "sessionId": sessionId,
        "callId": callId,
        "toolName": toolName,
        "input": argumentsJson,
      ])
    }
  }

  func resolve(callId: String, resultJson: String, errorMessage: String?) {
    lock.lock()
    let cont = continuations.removeValue(forKey: callId)
    lock.unlock()
    guard let cont else { return }
    if let errorMessage, !errorMessage.isEmpty {
      cont.resume(throwing: AppleLlmToolError.jsError(errorMessage))
    } else {
      cont.resume(returning: resultJson)
    }
  }

  func cancelAll() {
    lock.lock()
    let pending = continuations
    continuations.removeAll()
    lock.unlock()
    for cont in pending.values { cont.resume(throwing: AppleLlmToolError.cancelled) }
  }
}

// MARK: - BridgedTool

#if canImport(FoundationModels)
/// A FoundationModels tool whose execution is delegated to JavaScript. The model
/// produces schema-valid `GeneratedContent` arguments; we forward them (as JSON)
/// to JS via the `invoke` closure, suspend until JS resolves the result, and
/// return that text to the model so it can continue the turn.
///
/// `invoke` is a @Sendable closure (not a module reference) so the tool stays
/// Sendable as the Tool protocol requires.
@available(iOS 26.0, *)
struct BridgedTool: Tool {
  typealias Arguments = GeneratedContent
  typealias Output = String

  let name: String
  let description: String
  let parameters: GenerationSchema
  let invoke: @Sendable (_ toolName: String, _ argumentsJson: String) async throws -> String

  func call(arguments: GeneratedContent) async throws -> String {
    return try await invoke(name, arguments.jsonString)
  }
}
#endif
