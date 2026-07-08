# Plan: On-device / Private Cloud Compute Apple Intelligence provider

**Status:** PCC IMPLEMENTED (2026-07-08). Private Cloud Compute is now the
user-facing "Apple Intelligence" provider (full tool set, full system prompt,
32K window, `moderate` reasoning, quota UI). The on-device (iOS 26) model is
retained but DEV-ONLY behind `EXPO_PUBLIC_APPLE_LLM_DEV` (too weak for agentic
tool use). Verified: JS type-check + lint clean; Swift parses clean under BOTH
the stable iOS-26 SDK (PCC compiled out) and the beta iOS-27 SDK (PCC compiled
in). Pending device verification on iOS 27 with the granted entitlement.

### EAS-safety: the CAIRN_PCC_SDK compile-time gate (critical)

PCC symbols (`PrivateCloudComputeLanguageModel`, `ContextOptions.ReasoningLevel`,
`.quotaLimitReached`, `quotaUsage`) exist ONLY in the iOS 27 SDK. `#available(iOS
27)` is a RUNTIME check — it does NOT stop the compiler needing those symbols to
exist. `#if canImport(FoundationModels)` is TRUE on both SDK 26 and 27 (only the
PCC types within it are new), so it can't gate them either. The current EAS iOS
image is `macos-tahoe-26.4-xcode-26.4` (iOS 26 SDK) — referencing PCC symbols
unconditionally there FAILS the build.

Fix (`modules/apple-llm/ios/AppleLlm.podspec`): read the active iOS SDK version
at pod-eval time (`xcrun --sdk iphoneos --show-sdk-version`) and define the
`CAIRN_PCC_SDK` compilation condition ONLY when the SDK major is ≥ 27. ALL PCC
symbol references live inside `#if CAIRN_PCC_SDK`. Result:
- EAS / stable Xcode 26 (iOS 26 SDK) → flag off → PCC compiled out → builds green,
  PCC reports unavailable at runtime.
- Local Xcode 27 beta (`/Applications/Xcode-beta.app`, iOS 27 SDK) → flag on →
  PCC compiled in + runs. Point the toolchain at it:
  `sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer`
  (or prefix a build with `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`).
- Future EAS iOS 27 image → flips on automatically, zero code change.

### SDK API gotcha: LanguageModelSession init + `LanguageModel` are iOS-27-only

Verified against the iOS 27 SDK `.swiftinterface` (build error surfaced it):
- The **unified** `LanguageModelSession.init(model: some LanguageModel, tools:, instructions:)` and the `LanguageModel` protocol itself are **iOS 27.0+**. Passing a `PrivateCloudComputeLanguageModel` REQUIRES this init.
- iOS 26 only has the **concrete** `init(model: SystemLanguageModel = .default, tools:, instructions:)`.
- So there is NO single shared init/`resolveModel(): any LanguageModel` (that annotation compiled under `@available(iOS 26)` but references 27-only symbols → error). `ensureSession` must branch: server path (`#if CAIRN_PCC_SDK` + `#available(iOS 27)`) builds with `PrivateCloudComputeLanguageModel()` via the `some LanguageModel` init; on-device path uses the concrete-`SystemLanguageModel` init.
- Likewise `streamResponse(to:options:contextOptions:)` is iOS 27+ (base `streamResponse(to:options:)` is iOS 26); reasoning is applied only on the server path.
- Quota/availability shapes confirmed: `PrivateCloudComputeLanguageModel()`, `.availability → .available/.unavailable(.deviceNotEligible|.systemNotReady)`, `.quotaUsage.status → .belowLimit(BelowLimit{isApproachingLimit})`, `.isLimitReached`, `.limitIncreaseSuggestion?.show()`, `.resetDate`, `Error.quotaLimitReached(_)`.
- **Verified:** AppleLlm pod `xcodebuild BUILD SUCCEEDED` under iOS 27 SDK (flag on); parses clean under iOS 26 SDK (flag off).

### Entitlement gating (critical)

`com.apple.developer.private-cloud-compute` is a MANAGED entitlement
without it being provisioned for the App ID BREAKS code-signing on every build.
`plugins/withPrivateCloudCompute.js` therefore injects it ONLY when
`EXPO_PUBLIC_PCC=1`. Set that flag only once the entitlement is granted AND you
build the iOS 27 SDK variant. The app runs fine without it (PCC just reports
unavailable), so shipped/EAS builds stay signable.

---

## Original shelving context (on-device)

On-device (iOS 26) implementation exists but is **not viable** for Cairn's
agentic tool use. Re-implemented against **Private Cloud Compute (PCC)** — see
status above.

---

## Current gating (dev-only, hidden from users)

The on-device provider is **hidden from end users** but kept for local iteration,
gated on a build-time flag:

- `EXPO_PUBLIC_APPLE_LLM_DEV=1` in the local, git-ignored `mobile/.env` exposes the
  "On-device" provider (Settings → AI, `resolveProvider`, `hasProvider`).
- EAS `preview`/`production` builds don't receive `.env` and the flag isn't set in
  `eas.json`, so the var is `undefined` → `isAppleDevEnabled()` is false → the
  provider never appears or resolves in shipped builds.
- Central gate: `isAppleProviderAvailable()` = `isAppleDevEnabled() && isAppleLlmAvailable()`
  in `src/chat/providers/apple.ts`. All consumers already route through it.
- The native module (`modules/apple-llm`) still **compiles** in EAS (autolinked,
  tiny, dormant — never invoked when the flag is off). We deliberately did NOT
  exclude it from the native build, to keep local/EAS prebuild identical and avoid
  a fragile conditional-autolinking setup.

To fully remove it later (if PCC supersedes it), delete `modules/apple-llm`,
`src/chat/providers/apple.ts`, the `"apple"` `ProviderPref` value, the settings
segment, and the `resetAppleSession` wiring — git history + this doc are the recipe.

## TL;DR

- We built a complete on-device Apple Foundation Models provider (`modules/apple-llm`
  + `src/chat/providers/apple.ts`) using native tool-calling via guided generation.
  It compiles and runs, but the **~3B on-device model is too weak** for Cairn's
  multi-tool agent flow and the **4096-token context window** is too small once the
  system prompt + tool schemas are included. It could not reliably answer even a
  single-project question.
- **PCC is the fix**: same unified `LanguageModelSession` API, one-line model swap
  (`PrivateCloudComputeLanguageModel()`), **32K context**, stronger reasoning, no
  API keys, no server to run. Requires iOS 27+, a **managed entitlement**
  (`com.apple.developer.private-cloud-compute`, applied for), and a network
  connection.
- The **entire tool-bridge architecture we built carries over unchanged** — tools,
  instructions, streaming, and the `respond`/`streamResponse` calls are identical
  across on-device and PCC models. Only the model instance and availability/quota
  handling differ.

---

## What already exists in the repo (the reusable foundation)

All of this is compiled/verified against the iOS 26.5 SDK (Xcode 26.6) and can be
reused directly for PCC:

| File | Role | Reuse for PCC |
|------|------|---------------|
| `mobile/modules/apple-llm/ios/AppleLlmModule.swift` | Expo module: session cache, streaming, tool bridge, `generate`/`resetSession`/`prewarm`/`resolveToolCall`, availability | **Reuse**; swap the model instance + add quota handling |
| `mobile/modules/apple-llm/ios/AppleLlmSchemaParser.swift` | JSON Schema → `DynamicGenerationSchema` → `GenerationSchema` | **Reuse as-is** |
| `mobile/modules/apple-llm/index.ts` + `AppleLlm.types.ts` | Typed JS bridge | **Reuse**; add quota events/fields |
| `mobile/src/chat/providers/apple.ts` | `ChatProvider` — native tools, `tool-executed` events, lean schemas, persistent per-thread session, short system prompt | **Reuse**; relax the 4096 tuning for 32K |
| `mobile/src/chat/providers/types.ts` | `tool-executed` StreamEvent (provider ran the tool; agent must not re-run) | **Reuse** |
| `mobile/src/chat/providers/index.ts`, `ai-config.ts` | `ProviderPref = "rork" \| "openai" \| "apple"`, resolve/fallback, availability gating | **Reuse** |
| `mobile/src/components/AiSettingsForm.tsx` | "On-device" provider segment, availability gate | **Reuse**; relabel + quota UI |

### Key architecture decisions (already made, keep them)

1. **Native tool-calling, not prompt-injection.** Each Cairn tool's JSON Schema
   becomes a native `GenerationSchema` via `DynamicGenerationSchema` (guided
   generation), so the model is *constrained* to emit valid arguments. An earlier
   text-parsing approach (`<tool_call>{…}</tool_call>`) was unreliable and was
   removed.
2. **Tools execute in JS, not Swift.** `BridgedTool: Tool` (`Arguments =
   GeneratedContent`, `Output = String`). `call()` suspends on a
   `CheckedContinuation`, fires an `onToolCall` event to JS; JS runs the local
   SQLite tool (`TOOL_MAP`) and calls `resolveToolCall(callId, resultJson)` to
   resume the native turn. State lives in a `ToolBridge: @unchecked Sendable`
   (lock-guarded continuation dict) so the tool stays `Sendable`.
3. **`tool-executed` StreamEvent.** Because Apple runs the multi-tool loop
   *inside one `generate()`*, the provider emits `tool-executed` (with output) so
   `agent.ts` shows the tool in the UI trail but does NOT re-run it (Rork/OpenAI
   still use `tool-input-available` + the agent's own loop).
4. **Persistent session per chat thread.** Swift caches a `LanguageModelSession`
   by a JS `sessionId`; `generate` sends only the newest user turn (transcript
   carried natively). `resetAppleSession()` (JS) on chat-clear bumps the id.
5. **NativeModule typing gotcha.** The native module type must be
   `declare class X extends NativeModule<Events>` with a **value** import of
   `NativeModule` from `expo` — an interface-extends + type-only import does not
   inherit `addListener`.

### Verified FoundationModels API (from the SDK `.swiftinterface`)

- `SystemLanguageModel.default.availability` → `.available` / `.unavailable(UnavailableReason)`;
  `UnavailableReason`: `.deviceNotEligible`, `.appleIntelligenceNotEnabled`, `.modelNotReady`.
- `LanguageModelSession(model:tools:instructions:)`; `.streamResponse(to: String, options:)`
  → `ResponseStream<String>`; iterating yields `Snapshot` with `.content: String` (cumulative).
- `GenerationOptions(sampling:temperature:maximumResponseTokens:)`.
- `LanguageModelSession.GenerationError.exceededContextWindowSize` / `.assetsUnavailable`.
- `Tool` protocol; `DynamicGenerationSchema` (objects/arrays/enum/pattern/number bounds/anyOf),
  `GenerationSchema(root:dependencies:)`, `GeneratedContent.jsonString` / `init(json:)`.

---

## Why on-device failed (Apple's own guidance)

From `managing-the-context-window` and `prompting-an-on-device-foundation-model`:

- Fixed **4096-token** window covers instructions + transcript + **tool definitions +
  schemas** + output. Cairn's ~11 tools' schemas + system prompt leave too little for
  reasoning.
- On-device model is small; "may get confused with long/indirect instructions",
  struggles with multi-step orchestration, "split into simpler requests".

We already mitigated (persistent session, short prompt, lean schemas, native tools) —
still not enough. This is a model-capability ceiling, not a wiring bug. **PCC's 32K
window + stronger reasoning is the actual fix.**

---

## PCC re-implementation plan

### Prerequisites
- [ ] Managed entitlement `com.apple.developer.private-cloud-compute` granted
      (applied for). Add it via a config plugin (mirror `plugins/withICloudContainer.js`).
- [ ] Xcode with an **iOS 27 SDK** (PCC types are iOS 27+; not present in 26.5).
- [ ] Test device on iOS 27 with Apple Intelligence enabled.

### Native changes (`AppleLlmModule.swift`)
1. **Model selection.** Add a `useServer: Bool` (or a `modelKind` string) to
   `generate`/`ensureSession`. Build the session with the right model:
   ```swift
   if useServer, #available(iOS 27.0, *) {
     session = LanguageModelSession(model: PrivateCloudComputeLanguageModel(),
                                    tools: bridgedTools, instructions: instructions)
   } else {
     session = LanguageModelSession(model: SystemLanguageModel.default,
                                    tools: bridgedTools, instructions: instructions)
   }
   ```
   Everything else (streaming, tool bridge, schema parser) is unchanged — this is
   Apple's whole selling point ("change a single line of code… tools and
   instructions carry over").
2. **Availability.** Add a PCC availability probe using
   `PrivateCloudComputeLanguageModel().availability` with the new
   `.unavailable(.systemNotReady)` / `.deviceNotEligible` cases (all `@available(iOS 27)`).
3. **Reasoning level (optional, high value for Cairn).** PCC supports
   `ContextOptions(reasoningLevel: .standard/.enhanced/.deep)`. Pass a level from JS
   options; use `.deep` for hard planning, `.standard` default. Note: deeper reasoning
   consumes more of the (32K) window and adds latency.
4. **Quota handling.** Surface `model.quotaUsage` (status: below/approaching/exceeded,
   `limitIncreaseSuggestion`, reset date) and the `exceededQuota` error. Emit a new
   `onQuota` event or expose a `quotaStatus()` function. Map `exceededQuota` to a new
   `AppleLLMErrorCode` (e.g. `QUOTA_EXCEEDED`).
5. **Network fallback.** If a PCC request fails due to no network, retry on-device
   (or surface a clear "needs a connection" error, like the existing cloud providers).

### JS/provider changes
1. **New ProviderPref value** or a sub-mode: e.g. `"apple"` stays on-device,
   add `"apple-cloud"` — OR keep one `"apple"` pref with an availability-driven
   auto-upgrade to PCC when on iOS 27 + entitled. Recommended: a single "Apple
   Intelligence" provider that prefers PCC when available and falls back to
   on-device, exposed in settings with a "Use cloud (Private Cloud Compute)" toggle.
2. **Relax the 4096 tuning for PCC.** With 32K, we can:
   - Restore richer tool descriptions (the `leanSchema()` stripping is only needed
     for the tiny window; keep it for on-device, relax for PCC).
   - Use the full agent system prompt instead of the terse `appleSystemPrompt()`.
   - Raise `maxTokens`.
   Gate these on the model kind.
3. **Quota UX.** Add a small status line + "Show options" (iCloud+ upgrade) in the
   chat/composer when `quotaUsage` is approaching/exceeded; use Apple's
   `limitIncreaseSuggestion.show()` via a native function.
4. **Consider re-enabling the full multi-tool agent flow.** With PCC's reasoning +
   32K, the model should handle the whole 11-tool set reliably. Keep the native
   tool-bridge (Apple runs the loop internally, emits `tool-executed`).

### Settings UI
- Relabel the "On-device" segment; when PCC is available show a sub-toggle
  "Private Cloud Compute (larger, cloud, uses daily quota)".
- Show availability reason + quota status.

### Testing (Xcode helpers)
- Xcode Scheme → Run → Options → "Simulated Apple Foundation Models Availability":
  "Approaching Quota Usage Limit" / "Quota Usage Limit Reached" to test quota UI
  without burning real quota.

---

## Open questions / risks
- **iOS 27 minimum for PCC** — our current on-device path is iOS 26. Decide whether
  PCC is an iOS-27-only enhancement layered on the iOS-26 on-device base, or whether
  we drop on-device entirely and make Apple = PCC-only (simpler, but iOS 27+ only and
  online-only).
- **Daily quota** — PCC has per-user daily limits (iCloud+ upgradable). For a
  power-user tool like Cairn this may be limiting; keep Rork/OpenAI as the primary
  and Apple/PCC as a privacy-preserving option.
- **Entitlement gating** — the managed entitlement means third-party builds of Cairn
  can't use PCC unless separately entitled; keep OpenAI-compatible as the BYO path.

## Doc-fetching note
Apple's Foundation Models docs are a JS SPA that WebFetch/defuddle can't read. Fetch
the JSON backend instead:
`https://developer.apple.com/tutorials/data/documentation/foundationmodels/<page>.json`
(e.g. `adding-server-side-intelligence-with-private-cloud-compute.json`).

## References
- Adding server-side intelligence with Private Cloud Compute
- Expanding generation with tool calling
- Managing the context window
- Prompting an on-device foundation model
- Entitlement: `com.apple.developer.private-cloud-compute`
