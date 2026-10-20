import ExpoModulesCore
import AVFoundation

public class VideoFlipModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoFlip")

    AsyncFunction("flipHorizontal") { (uri: String, options: [String: Any]) async throws -> String in
      try await VideoFlipper.flipHorizontal(uri: uri, options: options)
    }

    AsyncFunction("processImage") { (uri: String, options: [String: Any]) async throws -> String in
      try await ImageMark.process(uri: uri, options: options)
    }

    AsyncFunction("sampleFrames") { (uri: String, count: Int) async throws -> [String] in
      try await ImageMark.sampleFrames(uri: uri, count: count)
    }

    AsyncFunction("joinVideos") { (uris: [String]) async throws -> String in
      try await Concat.join(uris: uris)
    }

    AsyncFunction("makePoster") { (script: String, backgroundUri: String) async throws -> String in
      try await PosterMaker.make(script: script, backgroundUri: backgroundUri)
    }

    Function("removeTempFile") { (uri: String) in
      VideoFlipper.removeTempFile(uri: uri)
    }
  }
}

private enum VideoFlipError: LocalizedError {
  case badUri
  case noVideoTrack
  case exporterUnavailable
  case exportFailed(String)

  var errorDescription: String? {
    switch self {
    case .badUri:
      return "找不到这个视频，请重新选择"
    case .noVideoTrack:
      return "这个文件里没有可翻转的画面"
    case .exporterUnavailable:
      return "系统无法导出这个视频"
    case .exportFailed(let message):
      return message
    }
  }
}

private enum VideoFlipper {
  static func flipHorizontal(uri: String, options: [String: Any]) async throws -> String {
    let sourceURL = try resolveFileURL(uri)
    let accessed = sourceURL.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        sourceURL.stopAccessingSecurityScopedResource()
      }
    }

    guard FileManager.default.fileExists(atPath: sourceURL.path) else {
      throw VideoFlipError.badUri
    }

    let asset = AVURLAsset(url: sourceURL)
    let videoTracks = try await asset.loadTracks(withMediaType: .video)
    guard let videoTrack = videoTracks.first else {
      throw VideoFlipError.noVideoTrack
    }

    let sourceRange = try await videoTrack.load(.timeRange)
    guard sourceRange.duration.isValid, sourceRange.duration.seconds > 0 else {
      throw VideoFlipError.noVideoTrack
    }

    let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first
    let extend = Self.parseExtend(options)
    let timeline: ClipTimeline.Result
    if let extend {
      timeline = try await ClipTimeline.build(
        video: videoTrack,
        audio: sourceAudio,
        sourceStart: sourceRange.start,
        sourceDuration: sourceRange.duration,
        extend: extend
      )
    } else {
      timeline = try await Self.plainTimeline(video: videoTrack, audio: sourceAudio, sourceRange: sourceRange)
    }
    let composition = timeline.composition
    let compositionVideoTrack = timeline.videoTrack
    let originalAudioTrack = timeline.audioTrack
    let timelineDuration = timeline.duration

    let subtitle = Self.subtitle(from: options)
    var narrationURL: URL?
    var speechDuration = 0.0
    var speechTrack: AVMutableCompositionTrack?
    defer {
      if let narrationURL {
        try? FileManager.default.removeItem(at: narrationURL)
      }
    }
    if !subtitle.isEmpty {
      let spoken = try await Narration.shared.speak(subtitle)
      narrationURL = spoken.url
      let speechAsset = AVURLAsset(url: spoken.url)
      if let sourceSpeech = try await speechAsset.loadTracks(withMediaType: .audio).first,
         let compositionSpeech = composition.addMutableTrack(
          withMediaType: .audio,
          preferredTrackID: kCMPersistentTrackID_Invalid
         ) {
        let speechRange = try await sourceSpeech.load(.timeRange)
        let usable = CMTimeMinimum(timelineDuration, speechRange.duration)
        if usable.isValid, usable.seconds > 0.05 {
          try compositionSpeech.insertTimeRange(
            CMTimeRange(start: speechRange.start, duration: usable),
            of: sourceSpeech,
            at: .zero
          )
          speechTrack = compositionSpeech
          speechDuration = usable.seconds
        }
      }
      if speechTrack == nil {
        throw NarrationError.failed
      }
    }

    let naturalSize = try await videoTrack.load(.naturalSize)
    let preferredTransform = try await videoTrack.load(.preferredTransform)
    let mirrored = mirrorTransform(naturalSize: naturalSize, preferredTransform: preferredTransform)
    let renderSize = mirrored.1
    let transform = zoom(mirrored.0, renderSize: renderSize, scale: Self.zoomScale(from: options))

    guard renderSize.width >= 2, renderSize.height >= 2 else {
      throw VideoFlipError.noVideoTrack
    }

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: timelineDuration)

    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideoTrack)
    layerInstruction.setTransform(transform, at: .zero)
    if let replay = timeline.replayRange {
      let zoomed = zoom(transform, renderSize: renderSize, scale: 1.25)
      layerInstruction.setTransformRamp(fromStart: transform, toEnd: zoomed, timeRange: replay)
      layerInstruction.setTransform(transform, at: CMTimeAdd(replay.start, replay.duration))
    }
    instruction.layerInstructions = [layerInstruction]

    let rawFps = try await videoTrack.load(.nominalFrameRate)
    let fps: Float = (rawFps.isFinite && rawFps > 1 && rawFps <= 120) ? rawFps : 30 as Float
    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(Int(fps.rounded())))
    videoComposition.sourceTrackIDForFrameTiming = compositionVideoTrack.trackID
    let filterName = Self.filterName(from: options)
    let overlay = Self.needsOverlay(options: options, subtitle: subtitle)
    if filterName.isEmpty {
      WatermarkBurner.apply(
        to: videoComposition,
        renderSize: renderSize,
        duration: timelineDuration.seconds,
        options: options,
        subtitle: subtitle,
        speechDuration: speechDuration
      )
    }

    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("flipped-\(UUID().uuidString).mp4")
    if FileManager.default.fileExists(atPath: outputURL.path) {
      try FileManager.default.removeItem(at: outputURL)
    }

    let compatible = AVAssetExportSession.exportPresets(compatibleWith: asset)
    let preferredPresets = [
      AVAssetExportPresetHighestQuality,
      AVAssetExportPreset1920x1080,
      AVAssetExportPreset1280x720,
      AVAssetExportPresetMediumQuality,
    ]
    let preset = preferredPresets.first(where: { compatible.contains($0) }) ?? AVAssetExportPresetHighestQuality

    guard let exportSession = AVAssetExportSession(asset: composition, presetName: preset) else {
      throw VideoFlipError.exporterUnavailable
    }

    exportSession.outputURL = outputURL
    exportSession.outputFileType = .mp4
    exportSession.videoComposition = videoComposition
    exportSession.audioMix = audioMix(
      original: originalAudioTrack,
      speech: speechTrack,
      speechDuration: speechDuration
    )
    exportSession.shouldOptimizeForNetworkUse = true

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      exportSession.exportAsynchronously {
        switch exportSession.status {
        case .completed:
          continuation.resume()
        case .cancelled:
          continuation.resume(throwing: VideoFlipError.exportFailed("翻转已取消"))
        default:
          let reason = exportSession.error?.localizedDescription ?? "导出失败"
          continuation.resume(throwing: VideoFlipError.exportFailed(reason))
        }
      }
    }

    guard FileManager.default.fileExists(atPath: outputURL.path) else {
      throw VideoFlipError.exportFailed("翻转完成但没有生成文件")
    }

    guard !filterName.isEmpty else {
      return outputURL.absoluteString
    }

    let filtered = FileManager.default.temporaryDirectory
      .appendingPathComponent("flipped-look-\(UUID().uuidString).mp4")
    do {
      try await applyLook(source: outputURL, output: filtered, name: filterName)
      try? FileManager.default.removeItem(at: outputURL)
    } catch {
      try? FileManager.default.removeItem(at: filtered)
      throw error
    }
    guard overlay else {
      return filtered.absoluteString
    }

    let burned = FileManager.default.temporaryDirectory
      .appendingPathComponent("flipped-text-\(UUID().uuidString).mp4")
    do {
      try await burnOverlay(
        source: filtered,
        output: burned,
        options: options,
        subtitle: subtitle,
        speechDuration: speechDuration
      )
      try? FileManager.default.removeItem(at: filtered)
      return burned.absoluteString
    } catch {
      try? FileManager.default.removeItem(at: burned)
      throw error
    }
  }

  private static func plainTimeline(
    video: AVAssetTrack,
    audio: AVAssetTrack?,
    sourceRange: CMTimeRange
  ) async throws -> ClipTimeline.Result {
    let composition = AVMutableComposition()
    guard let compositionVideoTrack = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw VideoFlipError.exporterUnavailable
    }
    try compositionVideoTrack.insertTimeRange(sourceRange, of: video, at: .zero)
    compositionVideoTrack.preferredTransform = .identity
    var audioTrack: AVMutableCompositionTrack?
    if let audio,
       let compositionAudioTrack = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audio.load(.timeRange)
      let audioDuration = CMTimeMinimum(sourceRange.duration, audioRange.duration)
      if audioDuration.isValid, audioDuration.seconds > 0 {
        let range = CMTimeRange(start: audioRange.start, duration: audioDuration)
        try? compositionAudioTrack.insertTimeRange(range, of: audio, at: .zero)
        audioTrack = compositionAudioTrack
      }
    }
    return ClipTimeline.Result(
      composition: composition,
      videoTrack: compositionVideoTrack,
      audioTrack: audioTrack,
      duration: sourceRange.duration,
      replayRange: nil
    )
  }

  private static func applyLook(source: URL, output: URL, name: String) async throws {
    let asset = AVURLAsset(url: source)
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw VideoFlipError.noVideoTrack
    }
    let composition = AVMutableComposition()
    guard let compositionVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw VideoFlipError.exporterUnavailable
    }
    let range = try await videoTrack.load(.timeRange)
    try compositionVideo.insertTimeRange(range, of: videoTrack, at: .zero)
    if let audioTrack = try await asset.loadTracks(withMediaType: .audio).first,
       let compositionAudio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audioTrack.load(.timeRange)
      try? compositionAudio.insertTimeRange(audioRange, of: audioTrack, at: .zero)
    }
    let naturalSize = try await videoTrack.load(.naturalSize)
    let preferred = try await videoTrack.load(.preferredTransform)
    let fitted = CGRect(origin: .zero, size: naturalSize).applying(preferred)
    let renderSize = CGSize(width: abs(fitted.width), height: abs(fitted.height))
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: range.duration)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideo)
    layerInstruction.setTransform(preferred, at: .zero)
    instruction.layerInstructions = [layerInstruction]
    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    LookFilter.install(videoComposition, name: name)
    try await exportVideo(
      asset: asset,
      composition: composition,
      videoComposition: videoComposition,
      audioMix: nil,
      outputURL: output
    )
  }

  private static func burnOverlay(
    source: URL,
    output: URL,
    options: [String: Any],
    subtitle: String,
    speechDuration: Double
  ) async throws {
    let asset = AVURLAsset(url: source)
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw VideoFlipError.noVideoTrack
    }
    let composition = AVMutableComposition()
    guard let compositionVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw VideoFlipError.exporterUnavailable
    }
    let range = try await videoTrack.load(.timeRange)
    try compositionVideo.insertTimeRange(range, of: videoTrack, at: .zero)
    if let audioTrack = try await asset.loadTracks(withMediaType: .audio).first,
       let compositionAudio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audioTrack.load(.timeRange)
      try? compositionAudio.insertTimeRange(audioRange, of: audioTrack, at: .zero)
    }
    let naturalSize = try await videoTrack.load(.naturalSize)
    let preferred = try await videoTrack.load(.preferredTransform)
    let fitted = CGRect(origin: .zero, size: naturalSize).applying(preferred)
    let renderSize = CGSize(width: abs(fitted.width), height: abs(fitted.height))
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: range.duration)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideo)
    layerInstruction.setTransform(preferred, at: .zero)
    instruction.layerInstructions = [layerInstruction]
    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    WatermarkBurner.apply(
      to: videoComposition,
      renderSize: renderSize,
      duration: range.duration.seconds,
      options: options,
      subtitle: subtitle,
      speechDuration: speechDuration
    )
    try await exportVideo(
      asset: asset,
      composition: composition,
      videoComposition: videoComposition,
      audioMix: nil,
      outputURL: output
    )
  }

  private static func exportVideo(
    asset: AVAsset,
    composition: AVMutableComposition,
    videoComposition: AVMutableVideoComposition,
    audioMix: AVMutableAudioMix?,
    outputURL: URL
  ) async throws {
    if FileManager.default.fileExists(atPath: outputURL.path) {
      try FileManager.default.removeItem(at: outputURL)
    }
    let compatible = AVAssetExportSession.exportPresets(compatibleWith: asset)
    let preferredPresets = [
      AVAssetExportPresetHighestQuality,
      AVAssetExportPreset1920x1080,
      AVAssetExportPreset1280x720,
      AVAssetExportPresetMediumQuality,
    ]
    let preset = preferredPresets.first(where: { compatible.contains($0) }) ?? AVAssetExportPresetHighestQuality
    guard let exportSession = AVAssetExportSession(asset: composition, presetName: preset) else {
      throw VideoFlipError.exporterUnavailable
    }
    exportSession.outputURL = outputURL
    exportSession.outputFileType = .mp4
    exportSession.videoComposition = videoComposition
    exportSession.audioMix = audioMix
    exportSession.shouldOptimizeForNetworkUse = true
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      exportSession.exportAsynchronously {
        switch exportSession.status {
        case .completed:
          continuation.resume()
        case .cancelled:
          continuation.resume(throwing: VideoFlipError.exportFailed("翻转已取消"))
        default:
          let reason = exportSession.error?.localizedDescription ?? "导出失败"
          continuation.resume(throwing: VideoFlipError.exportFailed(reason))
        }
      }
    }
    guard FileManager.default.fileExists(atPath: outputURL.path) else {
      throw VideoFlipError.exportFailed("翻转完成但没有生成文件")
    }
  }

  private static func parseExtend(_ options: [String: Any]) -> ClipExtend? {
    guard let raw = options["extend"] as? [String: Any] else {
      return nil
    }
    guard let start = doubleValue(raw["start"]),
          let end = doubleValue(raw["end"]),
          let freeze = doubleValue(raw["freeze"]) else {
      return nil
    }
    return ClipExtend(start: start, end: end, freeze: freeze, mode: (raw["mode"] as? String) ?? "normal")
  }

  private static func filterName(from options: [String: Any]) -> String {
    guard let name = options["filter"] as? String else {
      return ""
    }
    switch name {
    case "vivid", "warm", "cool", "mono":
      return name
    default:
      return ""
    }
  }

  private static func needsOverlay(options: [String: Any], subtitle: String) -> Bool {
    if !subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return true
    }
    guard let raw = options["watermark"] as? [String: Any] else {
      return false
    }
    if let enabled = raw["enabled"] as? Bool {
      return enabled
    }
    if let enabled = raw["enabled"] as? NSNumber {
      return enabled.boolValue
    }
    return false
  }

  private static func doubleValue(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else {
      return nil
    }
    return number.doubleValue
  }

  static func removeTempFile(uri: String) {
    guard let url = try? resolveFileURL(uri) else {
      return
    }
    let tempRoot = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path
    let target = url.resolvingSymlinksInPath().path
    let prefix = tempRoot.hasSuffix("/") ? tempRoot : tempRoot + "/"
    guard target == tempRoot || target.hasPrefix(prefix) else {
      return
    }
    try? FileManager.default.removeItem(at: url)
  }

  private static func subtitle(from options: [String: Any]) -> String {
    (options["subtitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  private static func zoomScale(from options: [String: Any]) -> CGFloat {
    guard let number = options["zoom"] as? NSNumber else {
      return 1
    }
    return min(max(CGFloat(truncating: number), 1), 3)
  }

  private static func zoom(_ transform: CGAffineTransform, renderSize: CGSize, scale: CGFloat) -> CGAffineTransform {
    guard scale > 1.001 else {
      return transform
    }
    let centerX = renderSize.width / 2
    let centerY = renderSize.height / 2
    var next = transform
    next = next.concatenating(CGAffineTransform(translationX: -centerX, y: -centerY))
    next = next.concatenating(CGAffineTransform(scaleX: scale, y: scale))
    next = next.concatenating(CGAffineTransform(translationX: centerX, y: centerY))
    return next
  }

  private static func audioMix(
    original: AVMutableCompositionTrack?,
    speech: AVMutableCompositionTrack?,
    speechDuration: Double
  ) -> AVMutableAudioMix? {
    guard original != nil || speech != nil else {
      return nil
    }
    let mix = AVMutableAudioMix()
    var parameters: [AVMutableAudioMixInputParameters] = []
    if let original {
      let input = AVMutableAudioMixInputParameters(track: original)
      if speechDuration > 0.05 {
        input.setVolume(0.2, at: .zero)
        input.setVolume(1, at: CMTime(seconds: speechDuration, preferredTimescale: 600))
      } else {
        input.setVolume(1, at: .zero)
      }
      parameters.append(input)
    }
    if let speech {
      let input = AVMutableAudioMixInputParameters(track: speech)
      input.setVolume(1, at: .zero)
      parameters.append(input)
    }
    mix.inputParameters = parameters
    return mix
  }

  /// 先按拍摄方向摆正，再左右镜像，最后把画面移回可见区域。
  private static func mirrorTransform(
    naturalSize: CGSize,
    preferredTransform: CGAffineTransform
  ) -> (CGAffineTransform, CGSize) {
    let oriented = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform)
    let orientedWidth = abs(oriented.width)

    var transform = preferredTransform
    transform = transform.concatenating(CGAffineTransform(scaleX: -1, y: 1))
    transform = transform.concatenating(CGAffineTransform(translationX: orientedWidth, y: 0))

    let flipped = CGRect(origin: .zero, size: naturalSize).applying(transform)
    transform = transform.concatenating(
      CGAffineTransform(translationX: -flipped.origin.x, y: -flipped.origin.y)
    )

    let size = CGSize(
      width: evenPixel(abs(flipped.width)),
      height: evenPixel(abs(flipped.height))
    )
    return (transform, size)
  }

  private static func evenPixel(_ value: CGFloat) -> CGFloat {
    let rounded = Int(value.rounded())
    let even = rounded <= 2 ? 2 : (rounded % 2 == 0 ? rounded : rounded - 1)
    return CGFloat(even)
  }

  private static func resolveFileURL(_ uri: String) throws -> URL {
    let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasPrefix("/") {
      return URL(fileURLWithPath: trimmed)
    }
    if let url = URL(string: trimmed), url.isFileURL {
      return url
    }
    if trimmed.hasPrefix("file://") {
      let raw = String(trimmed.dropFirst("file://".count))
      return URL(fileURLWithPath: raw.removingPercentEncoding ?? raw)
    }
    throw VideoFlipError.badUri
  }
}
