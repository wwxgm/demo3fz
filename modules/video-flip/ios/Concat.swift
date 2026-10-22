import AVFoundation
import UIKit

enum ConcatError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

enum Concat {
  static func join(uris: [String]) async throws -> String {
    guard uris.count >= 2 else {
      throw ConcatError.message("至少需要两段视频")
    }
    guard uris.count <= 30 else {
      throw ConcatError.message("一次最多合并 30 个视频")
    }

    var accessed: [URL] = []
    defer {
      for url in accessed {
        url.stopAccessingSecurityScopedResource()
      }
    }

    var pieces: [Piece] = []
    for uri in uris {
      let url = try resolve(uri)
      if url.startAccessingSecurityScopedResource() {
        accessed.append(url)
      }
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw ConcatError.message("找不到其中一个视频，请重新选择")
      }
      pieces.append(try await loadPiece(url))
    }

    let canvas = evenSize(pieces[0].displaySize)
    let composition = AVMutableComposition()
    guard let videoTrack = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw ConcatError.message("系统无法拼接视频")
    }
    videoTrack.preferredTransform = .identity
    let hasAudio = pieces.contains { $0.audio != nil }
    let audioTrack: AVMutableCompositionTrack?
    if hasAudio {
      audioTrack = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )
    } else {
      audioTrack = nil
    }

    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
    var cursor = CMTime.zero
    for piece in pieces {
      try videoTrack.insertTimeRange(piece.range, of: piece.video, at: cursor)
      layer.setTransform(fit(piece: piece, canvas: canvas), at: cursor)
      if let sourceAudio = piece.audio, let audioTrack {
        let audioRange = try await sourceAudio.load(.timeRange)
        let overlap = CMTimeRange(start: piece.range.start, duration: piece.range.duration).intersection(audioRange)
        if overlap.duration.isValid, overlap.duration.seconds > 0.02 {
          let offset = CMTimeSubtract(overlap.start, piece.range.start)
          try? audioTrack.insertTimeRange(overlap, of: sourceAudio, at: CMTimeAdd(cursor, offset))
        }
      }
      cursor = CMTimeAdd(cursor, piece.range.duration)
    }

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: cursor)
    instruction.backgroundColor = UIColor.black.cgColor
    instruction.layerInstructions = [layer]

    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = canvas
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    applyRec709(videoComposition)

    let output = FileManager.default.temporaryDirectory.appendingPathComponent("joined-\(UUID().uuidString).mp4")
    try await export(composition: composition, videoComposition: videoComposition, output: output)
    return output.absoluteString
  }

  private struct Piece {
    let video: AVAssetTrack
    let audio: AVAssetTrack?
    let range: CMTimeRange
    let displaySize: CGSize
    let upright: CGAffineTransform
  }

  private static func loadPiece(_ url: URL) async throws -> Piece {
    let asset = AVURLAsset(url: url)
    guard let video = try await asset.loadTracks(withMediaType: .video).first else {
      throw ConcatError.message("有一个文件没有画面")
    }
    let range = try await video.load(.timeRange)
    guard range.duration.isValid, range.duration.seconds > 0.05 else {
      throw ConcatError.message("有一个视频太短，无法合并")
    }
    let natural = try await video.load(.naturalSize)
    let preferred = try await video.load(.preferredTransform)
    let oriented = CGRect(origin: .zero, size: natural).applying(preferred)
    let upright = preferred.concatenating(
      CGAffineTransform(translationX: -oriented.origin.x, y: -oriented.origin.y)
    )
    let display = CGSize(width: abs(oriented.width), height: abs(oriented.height))
    guard display.width >= 2, display.height >= 2 else {
      throw ConcatError.message("有一个视频画面尺寸无效")
    }
    let audio = try await asset.loadTracks(withMediaType: .audio).first
    return Piece(video: video, audio: audio, range: range, displaySize: display, upright: upright)
  }

  private static func fit(piece: Piece, canvas: CGSize) -> CGAffineTransform {
    let scale = min(canvas.width / piece.displaySize.width, canvas.height / piece.displaySize.height)
    let dx = (canvas.width - piece.displaySize.width * scale) / 2
    let dy = (canvas.height - piece.displaySize.height * scale) / 2
    return piece.upright
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(CGAffineTransform(translationX: dx, y: dy))
  }

  private static func evenSize(_ size: CGSize) -> CGSize {
    func even(_ value: CGFloat) -> CGFloat {
      let rounded = max(2, Int(value.rounded()))
      let next = rounded % 2 == 0 ? rounded : rounded - 1
      return CGFloat(max(2, next))
    }
    return CGSize(width: even(size.width), height: even(size.height))
  }

  private static func export(
    composition: AVMutableComposition,
    videoComposition: AVMutableVideoComposition,
    output: URL
  ) async throws {
    if FileManager.default.fileExists(atPath: output.path) {
      try FileManager.default.removeItem(at: output)
    }
    let compatible = AVAssetExportSession.exportPresets(compatibleWith: composition)
    let preferred = [
      AVAssetExportPresetHighestQuality,
      AVAssetExportPreset1920x1080,
      AVAssetExportPreset1280x720,
      AVAssetExportPresetMediumQuality,
    ]
    let preset = preferred.first(where: { compatible.contains($0) }) ?? AVAssetExportPresetHighestQuality
    guard let session = AVAssetExportSession(asset: composition, presetName: preset) else {
      throw ConcatError.message("系统无法导出合并后的视频")
    }
    session.outputURL = output
    session.outputFileType = .mp4
    session.videoComposition = videoComposition
    session.shouldOptimizeForNetworkUse = true
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      session.exportAsynchronously {
        switch session.status {
        case .completed:
          continuation.resume()
        case .cancelled:
          continuation.resume(throwing: ConcatError.message("合并已取消"))
        default:
          continuation.resume(throwing: ConcatError.message(session.error?.localizedDescription ?? "合并失败"))
        }
      }
    }
    guard FileManager.default.fileExists(atPath: output.path) else {
      throw ConcatError.message("合并完成但没有生成文件")
    }
  }

  private static func resolve(_ uri: String) throws -> URL {
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
    throw ConcatError.message("找不到这个视频，请重新选择")
  }
}
