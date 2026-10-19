import ExpoModulesCore
import AVFoundation

public class VideoFlipModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoFlip")

    AsyncFunction("flipHorizontal") { (uri: String) async throws -> String in
      try await VideoFlipper.flipHorizontal(uri: uri)
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
  static func flipHorizontal(uri: String) async throws -> String {
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

    let composition = AVMutableComposition()
    guard let compositionVideoTrack = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw VideoFlipError.exporterUnavailable
    }

    try compositionVideoTrack.insertTimeRange(sourceRange, of: videoTrack, at: .zero)
    compositionVideoTrack.preferredTransform = .identity

    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    if let audioTrack = audioTracks.first,
       let compositionAudioTrack = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audioTrack.load(.timeRange)
      let audioDuration = CMTimeMinimum(sourceRange.duration, audioRange.duration)
      if audioDuration.isValid, audioDuration.seconds > 0 {
        let range = CMTimeRange(start: audioRange.start, duration: audioDuration)
        try? compositionAudioTrack.insertTimeRange(range, of: audioTrack, at: .zero)
      }
    }

    let naturalSize = try await videoTrack.load(.naturalSize)
    let preferredTransform = try await videoTrack.load(.preferredTransform)
    let (transform, renderSize) = mirrorTransform(naturalSize: naturalSize, preferredTransform: preferredTransform)

    guard renderSize.width >= 2, renderSize.height >= 2 else {
      throw VideoFlipError.noVideoTrack
    }

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: sourceRange.duration)

    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideoTrack)
    layerInstruction.setTransform(transform, at: .zero)
    instruction.layerInstructions = [layerInstruction]

    let rawFps = try await videoTrack.load(.nominalFrameRate)
    let fps: Float = (rawFps.isFinite && rawFps > 1 && rawFps <= 120) ? rawFps : 30 as Float
    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(Int(fps.rounded())))
    videoComposition.sourceTrackIDForFrameTiming = compositionVideoTrack.trackID

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

    return outputURL.absoluteString
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
