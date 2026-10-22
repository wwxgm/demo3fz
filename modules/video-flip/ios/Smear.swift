import AVFoundation
import CoreImage

private enum SmearError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

private struct SmearSpot {
  var rect: CGRect
  var horizontal: Bool
  var start: Double
  var end: Double
}

enum Smear {
  private static let context = CIContext(options: [.cacheIntermediates: false])

  static func cover(uri: String, options: [String: Any]) async throws -> String {
    let spots = try parse(options["regions"])
    let url = try resolve(uri)
    let accessed = url.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        url.stopAccessingSecurityScopedResource()
      }
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw SmearError.message("找不到这个视频，请重新选择")
    }
    let asset = AVURLAsset(url: url)
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw SmearError.message("这个文件里没有画面")
    }
    let sourceRange = try await videoTrack.load(.timeRange)
    guard sourceRange.duration.isValid, sourceRange.duration.seconds > 0.2 else {
      throw SmearError.message("视频太短")
    }
    if sourceRange.duration.seconds > 180 {
      throw SmearError.message("请先把视频裁到 3 分钟以内")
    }
    let preferred = try await videoTrack.load(.preferredTransform)

    let composition = AVMutableComposition()
    guard let compositionVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw SmearError.message("系统无法处理这个视频")
    }
    try compositionVideo.insertTimeRange(sourceRange, of: videoTrack, at: .zero)
    compositionVideo.preferredTransform = preferred
    if let audio = try await asset.loadTracks(withMediaType: .audio).first,
       let compositionAudio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audio.load(.timeRange)
      let usable = CMTimeMinimum(sourceRange.duration, audioRange.duration)
      if usable.isValid, usable.seconds > 0.02 {
        try? compositionAudio.insertTimeRange(
          CMTimeRange(start: audioRange.start, duration: usable),
          of: audio,
          at: .zero
        )
      }
    }

    let active = spots
    let videoComposition = AVVideoComposition(asset: composition, applyingCIFiltersWithHandler: { request in
      let source = request.sourceImage
      let extent = source.extent
      guard extent.isInfinite == false, extent.isNull == false, extent.isEmpty == false,
            extent.width >= 2, extent.height >= 2 else {
        request.finish(with: source, context: context)
        return
      }
      let time = request.compositionTime.seconds
      var output = source
      for spot in active where time + 0.001 >= spot.start && time <= spot.end + 0.02 {
        output = paint(output, spot: spot, extent: extent)
      }
      request.finish(with: output.cropped(to: extent), context: context)
    })

    let output = FileManager.default.temporaryDirectory.appendingPathComponent("smear-\(UUID().uuidString).mp4")
    try await export(composition: composition, videoComposition: videoComposition, output: output)
    return output.absoluteString
  }

  private static func paint(_ image: CIImage, spot: SmearSpot, extent: CGRect) -> CIImage {
    let width = spot.rect.width * extent.width
    let height = spot.rect.height * extent.height
    let box = CGRect(
      x: extent.origin.x + spot.rect.origin.x * extent.width,
      y: extent.origin.y + (1 - spot.rect.origin.y - spot.rect.height) * extent.height,
      width: width,
      height: height
    ).integral.intersection(extent)
    guard box.width >= 2, box.height >= 2 else { return image }
    let strip = sampleStrip(box, extent: extent, horizontal: spot.horizontal)
    guard strip.width >= 1, strip.height >= 1 else { return image }
    let piece = image.cropped(to: strip)
    let scaleX = spot.horizontal ? box.width / max(strip.width, 1) : 1
    let scaleY = spot.horizontal ? 1 : box.height / max(strip.height, 1)
    let scaled = piece.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
    let placed = scaled.transformed(
      by: CGAffineTransform(translationX: box.minX - scaled.extent.minX, y: box.minY - scaled.extent.minY)
    ).cropped(to: box)
    guard placed.extent.isEmpty == false else { return image }
    return placed.composited(over: image)
  }

  private static func sampleStrip(_ box: CGRect, extent: CGRect, horizontal: Bool) -> CGRect {
    if horizontal {
      let left = CGRect(x: box.minX - 4, y: box.minY, width: 4, height: box.height).intersection(extent)
      if left.width >= 1, left.height >= 2 { return left }
      let right = CGRect(x: box.maxX, y: box.minY, width: 4, height: box.height).intersection(extent)
      if right.width >= 1, right.height >= 2 { return right }
      return CGRect(x: box.minX, y: box.minY, width: min(2, box.width), height: box.height)
    }
    let below = CGRect(x: box.minX, y: box.minY - 4, width: box.width, height: 4).intersection(extent)
    if below.width >= 2, below.height >= 1 { return below }
    let above = CGRect(x: box.minX, y: box.maxY, width: box.width, height: 4).intersection(extent)
    if above.width >= 2, above.height >= 1 { return above }
    return CGRect(x: box.minX, y: box.minY, width: box.width, height: min(2, box.height))
  }

  private static func parse(_ raw: Any?) throws -> [SmearSpot] {
    guard let rows = raw as? [[String: Any]], !rows.isEmpty else {
      throw SmearError.message("请先框住要涂抹的位置")
    }
    guard rows.count <= 8 else {
      throw SmearError.message("一次最多涂抹 8 处")
    }
    return try rows.map { row in
      guard let x = number(row["x"]), let y = number(row["y"]),
            let width = number(row["width"]), let height = number(row["height"]),
            let start = number(row["start"]), let end = number(row["end"]) else {
        throw SmearError.message("涂抹区域不完整")
      }
      guard start.isFinite, end.isFinite, start >= 0, end > start + 0.04 else {
        throw SmearError.message("涂抹的开始时间要小于结束时间")
      }
      let left = min(max(x, 0), 0.98)
      let top = min(max(y, 0), 0.98)
      let wide = min(max(width, 0.02), 1 - left)
      let high = min(max(height, 0.02), 1 - top)
      let direction = (row["direction"] as? String) ?? "horizontal"
      return SmearSpot(
        rect: CGRect(x: left, y: top, width: wide, height: high),
        horizontal: direction != "vertical",
        start: start,
        end: end
      )
    }
  }

  private static func number(_ value: Any?) -> Double? {
    (value as? NSNumber)?.doubleValue
  }

  private static func export(
    composition: AVMutableComposition,
    videoComposition: AVVideoComposition,
    output: URL
  ) async throws {
    if FileManager.default.fileExists(atPath: output.path) {
      try? FileManager.default.removeItem(at: output)
    }
    let compatible = AVAssetExportSession.exportPresets(compatibleWith: composition)
    let preferred = [
      AVAssetExportPresetHighestQuality,
      AVAssetExportPreset1920x1080,
      AVAssetExportPreset1280x720,
      AVAssetExportPresetMediumQuality,
    ]
    var presets = preferred.filter { compatible.contains($0) }
    if presets.isEmpty { presets = preferred }
    var last = "涂抹失败"
    for preset in presets {
      if FileManager.default.fileExists(atPath: output.path) {
        try? FileManager.default.removeItem(at: output)
      }
      guard let session = AVAssetExportSession(asset: composition, presetName: preset) else {
        last = "系统无法导出这个视频"
        continue
      }
      session.outputURL = output
      session.outputFileType = .mp4
      session.videoComposition = videoComposition
      session.shouldOptimizeForNetworkUse = false
      let failure: String? = await withCheckedContinuation { continuation in
        session.exportAsynchronously {
          switch session.status {
          case .completed:
            continuation.resume(returning: nil)
          case .cancelled:
            continuation.resume(returning: "涂抹已取消")
          default:
            continuation.resume(returning: session.error?.localizedDescription ?? "涂抹失败")
          }
        }
      }
      if failure == nil, FileManager.default.fileExists(atPath: output.path) {
        return
      }
      if failure == "涂抹已取消" {
        throw SmearError.message("涂抹已取消")
      }
      last = failure ?? "涂抹完成但没有生成文件"
      try? FileManager.default.removeItem(at: output)
    }
    throw SmearError.message(last)
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
    throw SmearError.message("找不到这个视频，请重新选择")
  }
}
