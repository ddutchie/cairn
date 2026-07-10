require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AppleLlm'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'Cairn'
  s.homepage       = 'https://github.com/gerardslee/cairn'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # FoundationModels is a weak-linked framework: it only exists on iOS 26+, so
  # the binary must load on older OSes (all API use is `if #available` gated).
  s.weak_framework = 'FoundationModels'

  # Private Cloud Compute (PrivateCloudComputeLanguageModel, ContextOptions
  # reasoning, quota APIs) only exists in the iOS 27+ SDK. Those symbols are
  # referenced ONLY inside `#if CAIRN_PCC_SDK`, and we define that flag only when
  # building against an iOS 27+ SDK. This keeps builds green on the current EAS
  # image (Xcode 26 / iOS 26 SDK, where the symbols don't exist) — the PCC code
  # is compiled out — while lighting up automatically under Xcode 27 locally and
  # on future EAS images. A runtime `#available(iOS 27)` check still gates
  # execution on-device.
  sdk_version = `xcrun --sdk iphoneos --show-sdk-version 2>/dev/null`.strip
  sdk_major = sdk_version.split('.').first.to_i
  pcc_flags = sdk_major >= 27 ? 'CAIRN_PCC_SDK' : ''

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => "$(inherited) #{pcc_flags}".strip
  }

  s.source_files = "**/*.{h,m,swift}"
end
