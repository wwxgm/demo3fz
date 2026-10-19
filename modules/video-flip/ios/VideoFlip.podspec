require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'VideoFlip'
  s.version        = package['version']
  s.summary        = 'Horizontally mirror a video'
  s.description    = 'Horizontally mirror a video and export an mp4'
  s.license        = 'MIT'
  s.author         = 'ageren'
  s.homepage       = 'https://localhost'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'Photos'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_STRICT_CONCURRENCY' => 'minimal'
  }
  s.source_files = '**/*.{h,m,mm,swift}'
end
