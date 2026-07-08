require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AppleEmbeddings'
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

  # NaturalLanguage ships on every supported iOS; NLContextualEmbedding is
  # iOS 17+, so all use of it is `@available(iOS 17.0, *)` gated to keep the
  # binary loading on the app's 16.4 floor.
  s.framework = 'NaturalLanguage'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
