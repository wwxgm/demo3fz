import AVFoundation
import CoreImage
import UIKit

private enum FaceCoverError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

enum FaceCover {
  private static let context = CIContext(options: [.cacheIntermediates: false])

  static func cover(uri: String, options: [String: Any]) async throws -> String {
    guard let closedUri = options["closedUri"] as? String, !closedUri.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw FaceCoverError.message("请先选择要盖住脸的表情")
    }
    let box = try parseBox(options)
    let talk = bool(options["talk"], default: true)
    let closed = try loadFace(closedUri)
    let open: CIImage?
    if talk, let openUri = options["openUri"] as? String, !openUri.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      open = try loadFace(openUri)
    } else {
      open = nil
    }

    let url = try resolve(uri)
    let accessed = url.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        url.stopAccessingSecurityScopedResource()
      }
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw FaceCoverError.message("找不到这个视频，请重新选择")
    }
    let asset = AVURLAsset(url: url)
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw FaceCoverError.message("这个文件里没有画面")
    }
    let sourceRange = try await videoTrack.load(.timeRange)
    guard sourceRange.duration.isValid, sourceRange.duration.seconds > 0.2 else {
      throw FaceCoverError.message("视频太短")
    }
    if sourceRange.duration.seconds > 180 {
      throw FaceCoverError.message("请先把视频裁到 3 分钟以内")
    }
    let preferred = try await videoTrack.load(.preferredTransform)
    let mouth = open == nil ? [] : (try await mouthOpen(
      asset: asset,
      origin: sourceRange.start.seconds,
      duration: sourceRange.duration.seconds
    ))

    let composition = AVMutableComposition()
    guard let compositionVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw FaceCoverError.message("系统无法处理这个视频")
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

    let videoComposition = AVVideoComposition(asset: composition, applyingCIFiltersWithHandler: { request in
      let source = request.sourceImage
      let extent = source.extent
      guard extent.isInfinite == false, extent.isNull == false, extent.isEmpty == false,
            extent.width >= 2, extent.height >= 2 else {
        request.finish(with: source, context: context)
        return
      }
      let index = Int((request.compositionTime.seconds * 30).rounded(.down))
      let talking = index >= 0 && index < mouth.count && mouth[index]
      let face = talking ? (open ?? closed) : closed
      let painted = place(face, on: source, box: box, extent: extent)
      request.finish(with: painted.cropped(to: extent), context: context)
    })

    let output = FileManager.default.temporaryDirectory.appendingPathComponent("face-\(UUID().uuidString).mp4")
    try await export(composition: composition, videoComposition: videoComposition, output: output)
    return output.absoluteString
  }

  private static func place(_ face: CIImage, on image: CIImage, box: CGRect, extent: CGRect) -> CIImage {
    let target = CGRect(
      x: extent.origin.x + box.origin.x * extent.width,
      y: extent.origin.y + (1 - box.origin.y - box.height) * extent.height,
      width: box.width * extent.width,
      height: box.height * extent.height
    ).integral.intersection(extent)
    guard target.width >= 2, target.height >= 2 else { return image }
    let sourceExtent = face.extent
    guard sourceExtent.width >= 2, sourceExtent.height >= 2 else { return image }
    let scale = max(target.width / sourceExtent.width, target.height / sourceExtent.height)
    let scaled = face.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let scaledExtent = scaled.extent
    let crop = CGRect(
      x: scaledExtent.midX - target.width / 2,
      y: scaledExtent.midY - target.height / 2,
      width: target.width,
      height: target.height
    )
    let fitted = scaled.cropped(to: crop)
    let placed = fitted.transformed(by: CGAffineTransform(
      translationX: target.minX - fitted.extent.minX,
      y: target.minY - fitted.extent.minY
    )).cropped(to: target)
    guard placed.extent.isEmpty == false else { return image }
    return placed.composited(over: image)
  }

  private static func mouthOpen(asset: AVAsset, origin: Double, duration: Double) async throws -> [Bool] {
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
      return []
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: 16_000,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ])
    output.alwaysCopiesSampleData = true
    guard reader.canAdd(output) else { return [] }
    reader.add(output)
    guard reader.startReading() else { return [] }
    defer { reader.cancelReading() }
    let limit = min(Int(duration * 30) + 2, 30 * 180)
    var energy = [Float](repeating: 0, count: limit)
    var counts = [Int](repeating: 0, count: limit)
    let sampleStep = 1.0 / 16_000
    var reachedEnd = false
    while let sample = output.copyNextSampleBuffer(), reachedEnd == false {
      let start = CMSampleBufferGetPresentationTimeStamp(sample).seconds - origin
      guard start.isFinite else { continue }
      if start >= duration { break }
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      var length = 0
      var pointer: UnsafeMutablePointer<Int8>?
      guard CMBlockBufferGetDataPointer(
        block,
        atOffset: 0,
        lengthAtOffsetOut: nil,
        totalLengthOut: &length,
        dataPointerOut: &pointer
      ) == noErr, let pointer else { continue }
      let count = length / MemoryLayout<Int16>.size
      guard count > 0 else { continue }
      pointer.withMemoryRebound(to: Int16.self, capacity: count) { samples in
        for index in 0..<count {
          let time = start + Double(index) * sampleStep
          if time < 0 { continue }
          let bucket = Int((time * 30).rounded(.down))
          if bucket >= limit {
            reachedEnd = true
            return
          }
          let value = Float(samples[index]) / 32768
          energy[bucket] += value * value
          counts[bucket] += 1
        }
      }
    }
    var levels: [Float] = []
    levels.reserveCapacity(limit)
    for index in 0..<limit {
      if counts[index] == 0 {
        levels.append(0)
      } else {
        levels.append(sqrt(energy[index] / Float(counts[index])))
      }
    }
    let peak = levels.max() ?? 0
    guard peak > 0.008 else {
      return Array(repeating: false, count: levels.count)
    }
    var open: [Bool] = []
    open.reserveCapacity(levels.count)
    var talking = false
    for level in levels {
      if talking {
        talking = level > peak * 0.16
      } else {
        talking = level > peak * 0.28
      }
      open.append(talking)
    }
    return open
  }

  private static func loadFace(_ uri: String) throws -> CIImage {
    let url = try resolve(uri)
    let accessed = url.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        url.stopAccessingSecurityScopedResource()
      }
    }
    guard let image = UIImage(contentsOfFile: url.path) else {
      throw FaceCoverError.message("找不到这张表情，请重新选择")
    }
    let longest = max(image.size.width, image.size.height)
    guard longest >= 2 else {
      throw FaceCoverError.message("这张表情无法使用")
    }
    let fitted = longest > 1024 ? image.size.applying(CGAffineTransform(scaleX: 1024 / longest, y: 1024 / longest)) : image.size
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = false
    let rendered = UIGraphicsImageRenderer(size: fitted, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: fitted))
    }
    guard let cg = rendered.cgImage else {
      throw FaceCoverError.message("这张表情无法使用")
    }
    return CIImage(cgImage: cg)
  }

  private static func parseBox(_ options: [String: Any]) throws -> CGRect {
    guard let x = number(options["x"]), let y = number(options["y"]),
          let width = number(options["width"]), let height = number(options["height"]) else {
      throw FaceCoverError.message("请先把表情拖到脸上")
    }
    let left = min(max(x, 0), 0.98)
    let top = min(max(y, 0), 0.98)
    let wide = min(max(width, 0.08), 1 - left)
    let high = min(max(height, 0.08), 1 - top)
    return CGRect(x: left, y: top, width: wide, height: high)
  }

  private static func bool(_ value: Any?, default defaultValue: Bool) -> Bool {
    if let flag = value as? Bool { return flag }
    if let number = value as? NSNumber { return number.boolValue }
    return defaultValue
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
    var last = "表情遮脸失败"
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
            continuation.resume(returning: "表情遮脸已取消")
          default:
            continuation.resume(returning: session.error?.localizedDescription ?? "表情遮脸失败")
          }
        }
      }
      if failure == nil, FileManager.default.fileExists(atPath: output.path) {
        return
      }
      if failure == "表情遮脸已取消" {
        throw FaceCoverError.message("表情遮脸已取消")
      }
      last = failure ?? "表情遮脸完成但没有生成文件"
      try? FileManager.default.removeItem(at: output)
    }
    throw FaceCoverError.message(last)
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
    throw FaceCoverError.message("找不到这个文件，请重新选择")
  }
}
