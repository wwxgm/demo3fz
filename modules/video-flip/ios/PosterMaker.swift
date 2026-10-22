import AVFoundation
import UIKit

enum PosterError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

enum PosterMaker {
  static func make(script: String, backgroundUri: String, options: [String: Any] = [:]) async throws -> String {
    let cards = storyCards(from: script)
    let ranked = cards.contains(where: { $0.rank })
    let rows = ranked ? [] : lines(from: script)
    if ranked {
      let rankCount = cards.filter { $0.rank }.count
      guard rankCount > 0 else {
        throw PosterError.message("请先输入文案")
      }
      guard rankCount <= 10 else {
        throw PosterError.message("排行最多 10 名")
      }
    } else {
      guard !rows.isEmpty else {
        throw PosterError.message("请先输入文案")
      }
      guard rows.count <= 16 else {
        throw PosterError.message("文案最多 16 行，请删短一点")
      }
    }

    let trimmedBackground = backgroundUri.trimmingCharacters(in: .whitespacesAndNewlines)
    let fill = Self.flag(options, key: "fill", default: true)
    let mute = Self.flag(options, key: "mute", default: true)
    let wantedSeconds = Self.scriptSeconds(
      ranked: ranked,
      rankCount: cards.filter { $0.rank }.count,
      lineCount: rows.count
    )
    if let clips = Self.clipList(options: options), !clips.isEmpty {
      return try await makeSequence(
        cards: cards,
        ranked: ranked,
        rows: rows,
        clips: clips,
        mute: mute,
        wantedSeconds: wantedSeconds
      )
    }
    var accessed: URL?
    var baseFile: URL?
    defer {
      accessed?.stopAccessingSecurityScopedResource()
      if let baseFile {
        try? FileManager.default.removeItem(at: baseFile)
      }
    }

    let source: AVURLAsset
    let renderSize: CGSize
    let transform: CGAffineTransform
    let timeline: CMTime
    if trimmedBackground.isEmpty {
      let size = CGSize(width: 1080, height: 1920)
      let url = try await writeBlack(size: size, seconds: wantedSeconds)
      baseFile = url
      source = AVURLAsset(url: url)
      renderSize = size
      transform = .identity
      timeline = CMTime(seconds: wantedSeconds, preferredTimescale: 600)
    } else {
      let url = try resolve(trimmedBackground)
      if url.startAccessingSecurityScopedResource() {
        accessed = url
      }
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw PosterError.message("找不到背景视频，请重新选择")
      }
      source = AVURLAsset(url: url)
      guard let track = try await source.loadTracks(withMediaType: .video).first else {
        throw PosterError.message("这个背景里没有画面")
      }
      let natural = try await track.load(.naturalSize)
      let preferred = try await track.load(.preferredTransform)
      let oriented = CGRect(origin: .zero, size: natural).applying(preferred)
      transform = preferred.concatenating(
        CGAffineTransform(translationX: -oriented.origin.x, y: -oriented.origin.y)
      )
      renderSize = evenSize(CGSize(width: abs(oriented.width), height: abs(oriented.height)))
      let range = try await track.load(.timeRange)
      guard range.duration.isValid, range.duration.seconds > 0.3 else {
        throw PosterError.message("背景视频太短")
      }
      if range.duration.seconds > 120 {
        throw PosterError.message("背景视频请控制在 2 分钟以内")
      }
      timeline = fill ? CMTime(seconds: wantedSeconds, preferredTimescale: 600) : range.duration
    }

    guard let videoTrack = try await source.loadTracks(withMediaType: .video).first else {
      throw PosterError.message("无法读取画面")
    }
    let sourceRange = try await videoTrack.load(.timeRange)
    let composition = AVMutableComposition()
    guard let compositionVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw PosterError.message("系统无法制作视频")
    }
    let rawDuration = minTime(sourceRange.duration, timeline)
    let stretch = fill && !trimmedBackground.isEmpty && sourceRange.duration.seconds + 0.08 < wantedSeconds
    var compositionAudio: AVMutableCompositionTrack?
    if stretch {
      compositionAudio = try await cover(
        video: videoTrack,
        audio: mute ? nil : try await source.loadTracks(withMediaType: .audio).first,
        sourceRange: sourceRange,
        target: timeline,
        composition: composition,
        compositionVideo: compositionVideo
      )
    } else {
      let insert = CMTimeRange(start: sourceRange.start, duration: rawDuration)
      try compositionVideo.insertTimeRange(insert, of: videoTrack, at: .zero)
      if !mute, let audio = try await source.loadTracks(withMediaType: .audio).first,
         let track = composition.addMutableTrack(
          withMediaType: .audio,
          preferredTrackID: kCMPersistentTrackID_Invalid
         ) {
        let audioRange = try await audio.load(.timeRange)
        let overlap = insert.intersection(audioRange)
        if overlap.duration.isValid, overlap.duration.seconds > 0.02 {
          try? track.insertTimeRange(overlap, of: audio, at: .zero)
          compositionAudio = track
        }
      }
    }
    compositionVideo.preferredTransform = .identity

    let composed = try await compositionVideo.load(.timeRange)
    let limit = minTime(composed.duration, timeline)
    let frames = max(Int(floor(limit.seconds * 30.0)), 1)
    let aligned = CMTime(value: CMTimeValue(frames), timescale: 30)
    if CMTimeCompare(CMTimeAdd(composed.start, composed.duration), aligned) > 0 {
      compositionVideo.removeTimeRange(
        CMTimeRange(start: aligned, duration: CMTimeSubtract(CMTimeAdd(composed.start, composed.duration), aligned))
      )
      if let compositionAudio {
        let audioRange = try await compositionAudio.load(.timeRange)
        let audioEnd = CMTimeAdd(audioRange.start, audioRange.duration)
        if CMTimeCompare(audioEnd, aligned) > 0 {
          let start = CMTimeMaximum(aligned, audioRange.start)
          if CMTimeCompare(audioEnd, start) > 0 {
            compositionAudio.removeTimeRange(CMTimeRange(start: start, duration: CMTimeSubtract(audioEnd, start)))
          }
        }
      }
    }

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: aligned)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideo)
    let posterFrame = CMTime(value: 1, timescale: 30)
    if stretch, aligned.seconds > 0.4, CMTimeCompare(aligned, posterFrame) > 0 {
      layerInstruction.setTransformRamp(
        fromStart: transform,
        toEnd: zoomAround(transform, renderSize: renderSize, scale: 1.18),
        timeRange: CMTimeRange(start: .zero, duration: CMTimeSubtract(aligned, posterFrame))
      )
    } else {
      layerInstruction.setTransform(transform, at: .zero)
    }
    instruction.layerInstructions = [layerInstruction]

    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    if ranked {
      burnRanking(cards, into: videoComposition, renderSize: renderSize, duration: aligned.seconds)
    } else {
      burn(rows, into: videoComposition, renderSize: renderSize, duration: aligned.seconds)
    }

    let output = FileManager.default.temporaryDirectory.appendingPathComponent("poster-\(UUID().uuidString).mp4")
    try await export(composition: composition, videoComposition: videoComposition, output: output)
    return output.absoluteString
  }

  private struct Clip {
    var uri: String
    var image: Bool
  }

  private struct Span {
    var start: CMTime
    var duration: CMTime
    var transform: CGAffineTransform
  }

  private static func clipList(options: [String: Any]) -> [Clip]? {
    guard let rows = options["backgrounds"] as? [[String: Any]], !rows.isEmpty else {
      return nil
    }
    return rows.compactMap { row in
      guard let uri = row["uri"] as? String else { return nil }
      let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return nil }
      let kind = (row["kind"] as? String) ?? "video"
      return Clip(uri: trimmed, image: kind == "image")
    }
  }

  private static func makeSequence(
    cards: [Card],
    ranked: Bool,
    rows: [String],
    clips: [Clip],
    mute: Bool,
    wantedSeconds: Double
  ) async throws -> String {
    guard clips.count <= 12 else {
      throw PosterError.message("背景最多 12 个")
    }
    let canvas = CGSize(width: 1080, height: 1920)
    let slotSeconds = max(wantedSeconds / Double(clips.count), 1.2)
    let slot = CMTime(seconds: slotSeconds, preferredTimescale: 600)
    var accessed: [URL] = []
    var temps: [URL] = []
    defer {
      for url in accessed {
        url.stopAccessingSecurityScopedResource()
      }
      for url in temps {
        try? FileManager.default.removeItem(at: url)
      }
    }

    let composition = AVMutableComposition()
    guard let compositionVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw PosterError.message("系统无法制作视频")
    }
    compositionVideo.preferredTransform = .identity
    var compositionAudio: AVMutableCompositionTrack?
    var cursor = CMTime.zero
    var spans: [Span] = []

    for (index, clip) in clips.enumerated() {
      let url = try resolve(clip.uri)
      if url.startAccessingSecurityScopedResource() {
        accessed.append(url)
      }
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw PosterError.message(clip.image ? "找不到这张背景图片" : "找不到背景视频，请重新选择")
      }
      if clip.image {
        let file = try await writeKenBurns(
          imageURL: url,
          size: canvas,
          seconds: slotSeconds,
          fadeIn: index > 0,
          fadeOut: index < clips.count - 1
        )
        temps.append(file)
        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
          throw PosterError.message("这张背景图片无法做成画面")
        }
        let range = try await track.load(.timeRange)
        let use = minTime(range.duration, slot)
        try compositionVideo.insertTimeRange(CMTimeRange(start: range.start, duration: use), of: track, at: cursor)
        spans.append(Span(start: cursor, duration: use, transform: .identity))
        cursor = CMTimeAdd(cursor, use)
      } else {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
          throw PosterError.message("这个背景里没有画面")
        }
        let range = try await track.load(.timeRange)
        guard range.duration.isValid, range.duration.seconds > 0.3 else {
          throw PosterError.message("背景视频太短")
        }
        if range.duration.seconds > 120 {
          throw PosterError.message("背景视频请控制在 2 分钟以内")
        }
        let audio = mute ? nil : try await asset.loadTracks(withMediaType: .audio).first
        let placed = try await placeVideo(
          track,
          audio: audio,
          range: range,
          at: cursor,
          slot: slot,
          into: compositionVideo,
          composition: composition,
          compositionAudio: &compositionAudio
        )
        let transform = try await fillTransform(track, canvas: canvas)
        spans.append(Span(start: cursor, duration: placed, transform: transform))
        cursor = CMTimeAdd(cursor, placed)
      }
    }

    let composed = try await compositionVideo.load(.timeRange)
    let frames = max(Int(floor(composed.duration.seconds * 30.0)), 1)
    let aligned = CMTime(value: CMTimeValue(frames), timescale: 30)
    if CMTimeCompare(CMTimeAdd(composed.start, composed.duration), aligned) > 0 {
      compositionVideo.removeTimeRange(
        CMTimeRange(
          start: aligned,
          duration: CMTimeSubtract(CMTimeAdd(composed.start, composed.duration), aligned)
        )
      )
    }
    if let compositionAudio {
      let audioRange = try await compositionAudio.load(.timeRange)
      let audioEnd = CMTimeAdd(audioRange.start, audioRange.duration)
      if CMTimeCompare(audioEnd, aligned) > 0 {
        let start = CMTimeMaximum(aligned, audioRange.start)
        if CMTimeCompare(audioEnd, start) > 0 {
          compositionAudio.removeTimeRange(
            CMTimeRange(start: start, duration: CMTimeSubtract(audioEnd, start))
          )
        }
      }
    }

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: aligned)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideo)
    let frame = CMTime(value: 1, timescale: 30)
    for span in spans {
      guard CMTimeCompare(span.start, aligned) < 0 else { continue }
      let at = CMTimeMinimum(span.start, CMTimeSubtract(aligned, frame))
      guard CMTimeCompare(at, aligned) < 0 else { continue }
      layerInstruction.setTransform(span.transform, at: at)
    }
    instruction.layerInstructions = [layerInstruction]

    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = canvas
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    if ranked {
      burnRanking(cards, into: videoComposition, renderSize: canvas, duration: aligned.seconds)
    } else {
      burn(rows, into: videoComposition, renderSize: canvas, duration: aligned.seconds)
    }
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("poster-\(UUID().uuidString).mp4")
    try await export(composition: composition, videoComposition: videoComposition, output: output)
    return output.absoluteString
  }

  private static func placeVideo(
    _ track: AVAssetTrack,
    audio: AVAssetTrack?,
    range: CMTimeRange,
    at cursor: CMTime,
    slot: CMTime,
    into compositionVideo: AVMutableCompositionTrack,
    composition: AVMutableComposition,
    compositionAudio: inout AVMutableCompositionTrack?
  ) async throws -> CMTime {
    let audioSpan = try await audio?.load(.timeRange)
    if audio != nil, compositionAudio == nil {
      compositionAudio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )
    }
    let audioTarget = compositionAudio
    func layAudio(videoRange: CMTimeRange, at atTime: CMTime, slowed: CMTime?) {
      guard let audio, let audioTarget, let audioSpan else { return }
      let overlap = videoRange.intersection(audioSpan)
      guard overlap.duration.isValid, overlap.duration.seconds > 0.02 else { return }
      let offset = CMTimeSubtract(overlap.start, videoRange.start)
      let insertAt = CMTimeAdd(atTime, offset)
      try? audioTarget.insertTimeRange(overlap, of: audio, at: insertAt)
      guard let slowed else { return }
      let audioSlowed = CMTimeMultiplyByFloat64(overlap.duration, multiplier: 2)
      audioTarget.scaleTimeRange(
        CMTimeRange(start: insertAt, duration: overlap.duration),
        toDuration: audioSlowed
      )
    }
    if range.duration.seconds + 0.05 >= slot.seconds {
      let use = minTime(range.duration, slot)
      let piece = CMTimeRange(start: range.start, duration: use)
      try compositionVideo.insertTimeRange(piece, of: track, at: cursor)
      layAudio(videoRange: piece, at: cursor, slowed: nil)
      return use
    }
    let slowed = CMTimeMultiplyByFloat64(range.duration, multiplier: 2)
    var local = CMTime.zero
    var loops = 0
    while local.seconds < slot.seconds - 0.02 {
      loops += 1
      if loops > 40 {
        throw PosterError.message("背景太短，铺不满这段文案")
      }
      let at = CMTimeAdd(cursor, local)
      try compositionVideo.insertTimeRange(range, of: track, at: at)
      compositionVideo.scaleTimeRange(CMTimeRange(start: at, duration: range.duration), toDuration: slowed)
      layAudio(videoRange: range, at: at, slowed: slowed)
      local = CMTimeAdd(local, slowed)
    }
    if local.seconds > slot.seconds + 0.02 {
      let cut = CMTimeAdd(cursor, slot)
      let end = CMTimeAdd(cursor, local)
      let extra = CMTimeRange(start: cut, duration: CMTimeSubtract(end, cut))
      compositionVideo.removeTimeRange(extra)
      if let audioTarget {
        let audioRange = try await audioTarget.load(.timeRange)
        let hit = extra.intersection(audioRange)
        if hit.isValid, hit.duration.isValid, hit.duration.seconds > 0.001 {
          audioTarget.removeTimeRange(hit)
        }
      }
      return slot
    }
    return local
  }

  private static func fillTransform(_ track: AVAssetTrack, canvas: CGSize) async throws -> CGAffineTransform {
    let natural = try await track.load(.naturalSize)
    let preferred = try await track.load(.preferredTransform)
    let oriented = CGRect(origin: .zero, size: natural).applying(preferred)
    let upright = preferred.concatenating(
      CGAffineTransform(translationX: -oriented.origin.x, y: -oriented.origin.y)
    )
    let display = CGSize(width: max(abs(oriented.width), 2), height: max(abs(oriented.height), 2))
    let scale = max(canvas.width / display.width, canvas.height / display.height)
    let dx = (canvas.width - display.width * scale) / 2
    let dy = (canvas.height - display.height * scale) / 2
    return upright
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(CGAffineTransform(translationX: dx, y: dy))
  }

  private static func writeKenBurns(
    imageURL: URL,
    size: CGSize,
    seconds: Double,
    fadeIn: Bool,
    fadeOut: Bool
  ) async throws -> URL {
    guard let source = UIImage(data: (try? Data(contentsOf: imageURL)) ?? Data()),
          let image = uprightImage(source, maxSide: 1920) else {
      throw PosterError.message("这张背景图片无法读取")
    }
    let width = Int(size.width)
    let height = Int(size.height)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("poster-photo-\(UUID().uuidString).mp4")
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
      ]
    )
    guard writer.canAdd(input) else {
      throw PosterError.message("无法生成图片背景")
    }
    writer.add(input)
    guard writer.startWriting() else {
      throw PosterError.message(writer.error?.localizedDescription ?? "无法生成图片背景")
    }
    writer.startSession(atSourceTime: .zero)
    let frameCount = max(Int((seconds * 30).rounded()), 30)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let queue = DispatchQueue(label: "poster.photo")
      var index = 0
      var finished = false
      input.requestMediaDataWhenReady(on: queue) {
        while input.isReadyForMoreMediaData && !finished {
          if index >= frameCount {
            finished = true
            writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frameCount), timescale: 30))
            input.markAsFinished()
            writer.finishWriting {
              if writer.status == .completed {
                continuation.resume()
              } else {
                continuation.resume(throwing: PosterError.message(writer.error?.localizedDescription ?? "图片背景导出失败"))
              }
            }
            return
          }
          let progress = CGFloat(index) / CGFloat(max(frameCount - 1, 1))
          let timeSeconds = Double(index) / 30.0
          var alpha: CGFloat = 1
          if fadeIn {
            alpha = min(alpha, CGFloat(min(max(timeSeconds / 0.35, 0), 1)))
          }
          if fadeOut {
            alpha = min(alpha, CGFloat(min(max((seconds - timeSeconds) / 0.35, 0), 1)))
          }
          guard let buffer = imageBuffer(image, width: width, height: height, progress: progress, alpha: alpha, pool: adaptor.pixelBufferPool) else {
            finished = true
            input.markAsFinished()
            continuation.resume(throwing: PosterError.message("无法绘制背景图片"))
            return
          }
          let time = CMTime(value: CMTimeValue(index), timescale: 30)
          if !adaptor.append(buffer, withPresentationTime: time) {
            finished = true
            input.markAsFinished()
            continuation.resume(throwing: PosterError.message(writer.error?.localizedDescription ?? "图片背景写入失败"))
            return
          }
          index += 1
        }
      }
    }
    return url
  }

  private static func uprightImage(_ image: UIImage, maxSide: CGFloat) -> CGImage? {
    let source = image.size
    guard source.width > 1, source.height > 1 else { return nil }
    let longSide = max(source.width, source.height)
    let fit = longSide > maxSide ? maxSide / longSide : 1
    let size = CGSize(width: max(2, floor(source.width * fit)), height: max(2, floor(source.height * fit)))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }.cgImage
  }

  private static func imageBuffer(
    _ image: CGImage,
    width: Int,
    height: Int,
    progress: CGFloat,
    alpha: CGFloat,
    pool: CVPixelBufferPool?
  ) -> CVPixelBuffer? {
    var pixel: CVPixelBuffer?
    if let pool {
      CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixel)
    } else {
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &pixel)
    }
    guard let pixel else { return nil }
    CVPixelBufferLockBaseAddress(pixel, [])
    defer { CVPixelBufferUnlockBaseAddress(pixel, []) }
    guard let base = CVPixelBufferGetBaseAddress(pixel) else { return nil }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixel)
    guard let context = CGContext(
      data: base,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else {
      return nil
    }
    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let source = CGSize(width: image.width, height: image.height)
    guard source.width > 1, source.height > 1 else { return nil }
    let zoom = 1 + 0.16 * sin(progress * .pi)
    let scale = max(CGFloat(width) / source.width, CGFloat(height) / source.height) * zoom
    let drawSize = CGSize(width: source.width * scale, height: source.height * scale)
    let origin = CGPoint(x: (CGFloat(width) - drawSize.width) / 2, y: (CGFloat(height) - drawSize.height) / 2)
    context.interpolationQuality = .high
    context.setAlpha(min(max(alpha, 0), 1))
    context.draw(image, in: CGRect(origin: origin, size: drawSize))
    return pixel
  }

  private struct Card {
    var headline: String
    var body: String
    var rank: Bool
  }

  private static func storyCards(from script: String) -> [Card] {
    let normalized = script.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    var cards: [Card] = []
    var seenRank = false
    for part in normalized.split(separator: "\n", omittingEmptySubsequences: true) {
      let line = part.trimmingCharacters(in: .whitespacesAndNewlines)
      if line.isEmpty {
        continue
      }
      if line.range(of: #"^第[0-9]+名"#, options: .regularExpression) != nil {
        seenRank = true
        let pieces = line.contains("｜") ? line.components(separatedBy: "｜") : line.components(separatedBy: "|")
        let headline = pieces[0].trimmingCharacters(in: .whitespaces)
        let body = pieces.dropFirst().joined(separator: "｜").trimmingCharacters(in: .whitespaces)
        cards.append(Card(headline: headline, body: body, rank: true))
      } else if !seenRank {
        if cards.isEmpty {
          cards.append(Card(headline: line, body: "", rank: false))
        } else {
          cards[0].headline += line
        }
      } else if var last = cards.last, last.rank, last.body.isEmpty {
        last.body = line
        cards[cards.count - 1] = last
      } else {
        cards.append(Card(headline: line, body: "", rank: false))
      }
    }
    return cards
  }

  private static func burnRanking(
    _ cards: [Card],
    into composition: AVMutableVideoComposition,
    renderSize: CGSize,
    duration: Double
  ) {
    let parent = CALayer()
    let videoLayer = CALayer()
    let canvas = CGRect(origin: .zero, size: renderSize)
    parent.frame = canvas
    videoLayer.frame = canvas
    parent.isGeometryFlipped = true
    parent.addSublayer(videoLayer)

    let width = renderSize.width * 0.88
    let ranks = cards.filter { $0.rank }
    let title = cards.first(where: { !$0.rank })?.headline ?? ""
    if !title.isEmpty {
      let font = UIFont.systemFont(ofSize: renderSize.width * 0.058, weight: .black)
      let box = wrappedSize(title, font: font, width: width)
      let layer = textLayer(styled(title, font: font), size: box)
      layer.position = CGPoint(x: renderSize.width / 2, y: renderSize.height * 0.1 + box.height / 2)
      flip(layer, delay: 0.05, duration: 0.32)
      parent.addSublayer(layer)
    }

    let lead = 0.9
    let each = max((max(duration, 1) - lead) / Double(max(ranks.count, 1)), 0.8)
    for (index, card) in ranks.enumerated() {
      let start = lead + Double(index) * each
      let end = index == ranks.count - 1 ? duration : start + each
      let group = CALayer()
      group.frame = canvas
      let headFont = UIFont.systemFont(ofSize: renderSize.width * 0.064, weight: .black)
      let bodyFont = UIFont.systemFont(ofSize: renderSize.width * 0.04, weight: .semibold)
      let head = rankHeadline(card.headline, font: headFont, width: width)
      let bodyBox = card.body.isEmpty ? .zero : wrappedSize(card.body, font: bodyFont, width: width)
      let headLayer = textLayer(head.text, size: head.size)
      let blockHeight = head.size.height + (bodyBox.height > 0 ? bodyBox.height + 18 : 0)
      var cursor = (renderSize.height - blockHeight) / 2 + 20
      headLayer.position = CGPoint(x: renderSize.width / 2, y: cursor + head.size.height / 2)
      group.addSublayer(headLayer)
      cursor += head.size.height + 18
      if bodyBox.height > 0 {
        let bodyLayer = textLayer(styled(card.body, font: bodyFont), size: bodyBox)
        bodyLayer.position = CGPoint(x: renderSize.width / 2, y: cursor + bodyBox.height / 2)
        group.addSublayer(bodyLayer)
      }
      hold(group, start: start, end: end, videoDuration: max(duration, end))
      spinIn(group, delay: start)
      parent.addSublayer(group)
    }

    composition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)
  }

  private static func rankHeadline(_ headline: String, font: UIFont, width: CGFloat) -> (text: NSAttributedString, size: CGSize) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let text = NSMutableAttributedString()
    let base: [NSAttributedString.Key: Any] = [
      .font: font,
      .paragraphStyle: paragraph,
    ]
    if let match = headline.range(of: #"^第[0-9]+名"#, options: .regularExpression) {
      var rankAttrs = base
      rankAttrs[.foregroundColor] = UIColor(red: 1, green: 0.86, blue: 0.28, alpha: 1)
      text.append(NSAttributedString(string: String(headline[match]), attributes: rankAttrs))
      var nameAttrs = base
      nameAttrs[.foregroundColor] = UIColor.white
      text.append(NSAttributedString(string: String(headline[match.upperBound...]), attributes: nameAttrs))
    } else {
      var attrs = base
      attrs[.foregroundColor] = UIColor.white
      text.append(NSAttributedString(string: headline, attributes: attrs))
    }
    let bounds = text.boundingRect(
      with: CGSize(width: width, height: 800),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      context: nil
    )
    return (text, CGSize(width: width, height: ceil(bounds.height) + font.pointSize * 0.45))
  }

  private static func textLayer(_ string: NSAttributedString, size: CGSize) -> CALayer {
    let pad = CGSize(width: ceil(size.width + 16), height: ceil(size.height + 20))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 2
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: pad, format: format).image { _ in
      string.draw(with: CGRect(x: 8, y: 10, width: size.width, height: size.height), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    }
    let layer = CALayer()
    layer.contents = image.cgImage
    layer.contentsScale = format.scale
    layer.contentsGravity = .resize
    layer.bounds = CGRect(origin: .zero, size: pad)
    layer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.85
    layer.shadowRadius = 8
    layer.shadowOffset = .zero
    return layer
  }

  private static func wrappedSize(_ text: String, font: UIFont, width: CGFloat) -> CGSize {
    let bounds = (text as NSString).boundingRect(
      with: CGSize(width: width, height: 2000),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: [.font: font],
      context: nil
    )
    return CGSize(width: width, height: ceil(bounds.height) + font.pointSize * 0.45)
  }

  private static func hold(_ layer: CALayer, start: Double, end: Double, videoDuration: Double) {
    let video = max(videoDuration, 0.4)
    let begin = min(max(start / video, 0), 0.97)
    let show = min(max((start + 0.28) / video, begin + 0.01), 0.98)
    let hide = min(max(end / video, show + 0.01), 1)
    let anim = CAKeyframeAnimation(keyPath: "opacity")
    if hide >= 0.99 {
      anim.values = [0, 0, 1, 1]
      anim.keyTimes = [0, NSNumber(value: begin), NSNumber(value: show), 1]
    } else {
      anim.values = [0, 0, 1, 1, 0]
      anim.keyTimes = [0, NSNumber(value: begin), NSNumber(value: show), NSNumber(value: hide), 1]
    }
    anim.duration = video
    anim.beginTime = AVCoreAnimationBeginTimeAtZero
    anim.fillMode = .both
    anim.isRemovedOnCompletion = false
    layer.opacity = 0
    layer.add(anim, forKey: "poster-hold")
  }

  private static func burn(_ rows: [String], into composition: AVMutableVideoComposition, renderSize: CGSize, duration: Double) {
    let clock = timing(lineCount: rows.count, limit: duration)
    let fitted = layout(rows, canvas: renderSize)
    let parent = CALayer()
    let videoLayer = CALayer()
    let canvas = CGRect(origin: .zero, size: renderSize)
    parent.frame = canvas
    videoLayer.frame = canvas
    parent.isGeometryFlipped = true
    parent.addSublayer(videoLayer)

    let totalHeight = fitted.sizes.reduce(0) { $0 + $1.height } + fitted.gap * CGFloat(max(rows.count - 1, 0))
    var top = (renderSize.height - totalHeight) / 2
    for (index, row) in rows.enumerated() {
      let box = fitted.sizes[index]
      let layer = textLayer(styled(row, font: fitted.font), size: box)
      layer.position = CGPoint(x: renderSize.width / 2, y: top + box.height / 2)
      flip(layer, delay: clock.gap * Double(index), duration: clock.flip)
      parent.addSublayer(layer)
      top += box.height + fitted.gap
    }

    composition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)
  }

  private static func spinIn(_ layer: CALayer, delay: Double) {
    layer.transform = CATransform3DIdentity
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 0.92
    scale.toValue = 1
    scale.duration = 0.28
    scale.beginTime = AVCoreAnimationBeginTimeAtZero + delay
    scale.timingFunction = CAMediaTimingFunction(name: .easeOut)
    scale.fillMode = .both
    scale.isRemovedOnCompletion = false
    layer.add(scale, forKey: "poster-scale")
  }

  private static func flip(_ layer: CALayer, delay: Double, duration: Double) {
    layer.transform = CATransform3DIdentity
    layer.opacity = 1
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 0.92
    scale.toValue = 1
    scale.duration = max(duration, 0.12)
    scale.beginTime = AVCoreAnimationBeginTimeAtZero + delay
    scale.timingFunction = CAMediaTimingFunction(name: .easeOut)
    scale.fillMode = .both
    scale.isRemovedOnCompletion = false
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0
    fade.toValue = 1
    fade.duration = max(duration * 0.65, 0.08)
    fade.beginTime = AVCoreAnimationBeginTimeAtZero + delay
    fade.fillMode = .both
    fade.isRemovedOnCompletion = false
    layer.add(scale, forKey: "poster-scale")
    layer.add(fade, forKey: "poster-fade")
  }

  private static func styled(_ text: String, font: UIFont) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    return NSAttributedString(string: text, attributes: [
      .font: font,
      .foregroundColor: UIColor.white,
      .paragraphStyle: paragraph,
    ])
  }

  private static func layout(_ rows: [String], canvas: CGSize) -> (font: UIFont, sizes: [CGSize], gap: CGFloat) {
    var point = min(canvas.width, canvas.height) * 0.18
    let floor = max(28, min(canvas.width, canvas.height) * 0.045)
    while point >= floor {
      let font = UIFont.systemFont(ofSize: point, weight: .black)
      let sizes = rows.map { measure($0, font: font) }
      let widest = sizes.map(\.width).max() ?? 0
      let gap = point * 0.06
      let height = sizes.reduce(0) { $0 + $1.height } + gap * CGFloat(max(rows.count - 1, 0))
      if widest <= canvas.width * 0.9 && height <= canvas.height * 0.72 {
        return (font, sizes, gap)
      }
      point -= 2
    }
    let font = UIFont.systemFont(ofSize: floor, weight: .black)
    return (font, rows.map { measure($0, font: font) }, floor * 0.06)
  }

  private static func measure(_ text: String, font: UIFont) -> CGSize {
    let size = (text as NSString).size(withAttributes: [.font: font])
    let pad = font.pointSize * 0.42
    return CGSize(width: ceil(size.width + pad), height: ceil(size.height + font.pointSize * 0.45))
  }

  private static func timing(lineCount: Int, limit: Double?) -> (gap: Double, flip: Double, total: Double) {
    let gap = 0.16
    let flip = 0.34
    let needed = Double(max(lineCount - 1, 0)) * gap + flip
    guard let limit else {
      return (gap, flip, max(4, needed + 1.6))
    }
    let room = max(limit * 0.72, 0.45)
    let scale = min(1, room / max(needed, 0.01))
    return (gap * scale, max(flip * scale, 0.12), limit)
  }

  private static func lines(from script: String) -> [String] {
    let normalized = script.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    var rows: [String] = []
    for part in normalized.split(separator: "\n", omittingEmptySubsequences: true) {
      let line = part.trimmingCharacters(in: .whitespaces)
      if line.isEmpty {
        continue
      }
      rows.append(contentsOf: chunk(line, limit: 8))
    }
    return rows
  }

  private static func chunk(_ line: String, limit: Int) -> [String] {
    let chars = Array(line)
    if chars.count <= limit {
      return [String(chars)]
    }
    var rows: [String] = []
    var index = 0
    while index < chars.count {
      let end = min(index + limit, chars.count)
      rows.append(String(chars[index..<end]))
      index = end
    }
    return rows
  }

  private static func writeBlack(size: CGSize, seconds: Double) async throws -> URL {
    let width = Int(size.width)
    let height = Int(size.height)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("poster-base-\(UUID().uuidString).mp4")
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
      ]
    )
    guard writer.canAdd(input) else {
      throw PosterError.message("无法生成黑底视频")
    }
    writer.add(input)
    guard writer.startWriting() else {
      throw PosterError.message(writer.error?.localizedDescription ?? "无法生成黑底视频")
    }
    writer.startSession(atSourceTime: .zero)
    let frames = max(Int((seconds * 30).rounded()), 30)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let queue = DispatchQueue(label: "poster.black")
      var index = 0
      var finished = false
      input.requestMediaDataWhenReady(on: queue) {
        while input.isReadyForMoreMediaData && !finished {
          if index >= frames {
            finished = true
            writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: 30))
            input.markAsFinished()
            writer.finishWriting {
              if writer.status == .completed {
                continuation.resume()
              } else {
                continuation.resume(throwing: PosterError.message(writer.error?.localizedDescription ?? "黑底视频导出失败"))
              }
            }
            return
          }
          guard let buffer = blackBuffer(width: width, height: height, pool: adaptor.pixelBufferPool) else {
            finished = true
            input.markAsFinished()
            continuation.resume(throwing: PosterError.message("无法生成黑底画面"))
            return
          }
          let time = CMTime(value: CMTimeValue(index), timescale: 30)
          if !adaptor.append(buffer, withPresentationTime: time) {
            finished = true
            input.markAsFinished()
            continuation.resume(throwing: PosterError.message(writer.error?.localizedDescription ?? "黑底画面写入失败"))
            return
          }
          index += 1
        }
      }
    }
    return url
  }

  private static func blackBuffer(width: Int, height: Int, pool: CVPixelBufferPool?) -> CVPixelBuffer? {
    var pixel: CVPixelBuffer?
    if let pool {
      CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixel)
    } else {
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &pixel)
    }
    guard let pixel else {
      return nil
    }
    CVPixelBufferLockBaseAddress(pixel, [])
    if let base = CVPixelBufferGetBaseAddress(pixel) {
      memset(base, 0, CVPixelBufferGetDataSize(pixel))
    }
    CVPixelBufferUnlockBaseAddress(pixel, [])
    return pixel
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
    var presets = preferred.filter { compatible.contains($0) }
    if presets.isEmpty {
      presets = preferred
    }
    var last = "制作失败"
    for preset in presets {
      if FileManager.default.fileExists(atPath: output.path) {
        try? FileManager.default.removeItem(at: output)
      }
      guard let session = AVAssetExportSession(asset: composition, presetName: preset) else {
        last = "系统无法导出大字报"
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
            continuation.resume(returning: "制作已取消")
          default:
            let ns = session.error as NSError?
            if ns?.domain == AVFoundationErrorDomain, ns?.code == -11841 {
              continuation.resume(returning: "画面合成不合法（-11841）。请重试。")
            } else if ns?.domain == AVFoundationErrorDomain, ns?.code == -11880 {
              continuation.resume(returning: "这个背景的画面时间不连续，系统没法按原样制作（-11880）")
            } else {
              continuation.resume(returning: session.error?.localizedDescription ?? "制作失败")
            }
          }
        }
      }
      if failure == nil, FileManager.default.fileExists(atPath: output.path) {
        return
      }
      if failure == "制作已取消" {
        throw PosterError.message("制作已取消")
      }
      last = failure ?? "制作完成但没有生成文件"
      try? FileManager.default.removeItem(at: output)
    }
    throw PosterError.message(last)
  }

  private static func evenSize(_ size: CGSize) -> CGSize {
    func even(_ value: CGFloat) -> CGFloat {
      let rounded = max(2, Int(value.rounded()))
      let next = rounded % 2 == 0 ? rounded : rounded - 1
      return CGFloat(max(2, next))
    }
    return CGSize(width: even(size.width), height: even(size.height))
  }

  private static func cover(
    video: AVAssetTrack,
    audio: AVAssetTrack?,
    sourceRange: CMTimeRange,
    target: CMTime,
    composition: AVMutableComposition,
    compositionVideo: AVMutableCompositionTrack
  ) async throws -> AVMutableCompositionTrack? {
    var compositionAudio: AVMutableCompositionTrack?
    let audioSpan: CMTimeRange?
    if let audio {
      audioSpan = try await audio.load(.timeRange)
    } else {
      audioSpan = nil
    }
    if audio != nil {
      compositionAudio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )
    }
    let slowed = CMTimeMultiplyByFloat64(sourceRange.duration, multiplier: 2)
    var cursor = CMTime.zero
    var loops = 0
    while cursor.seconds < target.seconds - 0.02 {
      loops += 1
      if loops > 80 {
        throw PosterError.message("背景太短，铺不满这段文案")
      }
      try compositionVideo.insertTimeRange(sourceRange, of: video, at: cursor)
      compositionVideo.scaleTimeRange(CMTimeRange(start: cursor, duration: sourceRange.duration), toDuration: slowed)
      if let audio, let compositionAudio, let audioSpan {
        let overlap = sourceRange.intersection(audioSpan)
        if overlap.duration.isValid, overlap.duration.seconds > 0.02 {
          let offset = CMTimeSubtract(overlap.start, sourceRange.start)
          let insertAt = CMTimeAdd(cursor, offset)
          try? compositionAudio.insertTimeRange(overlap, of: audio, at: insertAt)
          let audioSlowed = CMTimeMultiplyByFloat64(overlap.duration, multiplier: 2)
          compositionAudio.scaleTimeRange(
            CMTimeRange(start: insertAt, duration: overlap.duration),
            toDuration: audioSlowed
          )
        }
      }
      cursor = CMTimeAdd(cursor, slowed)
    }
    if compositionAudio == nil {
      return nil
    }
    let kept = try await compositionAudio?.load(.timeRange)
    if kept == nil || (kept?.duration.seconds ?? 0) < 0.02 {
      if let compositionAudio {
        composition.removeTrack(compositionAudio)
      }
      return nil
    }
    return compositionAudio
  }

  private static func zoomAround(_ transform: CGAffineTransform, renderSize: CGSize, scale: CGFloat) -> CGAffineTransform {
    let centerX = renderSize.width / 2
    let centerY = renderSize.height / 2
    return transform
      .concatenating(CGAffineTransform(translationX: -centerX, y: -centerY))
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(CGAffineTransform(translationX: centerX, y: centerY))
  }

  private static func scriptSeconds(ranked: Bool, rankCount: Int, lineCount: Int) -> Double {
    if ranked {
      return 1.2 + Double(max(rankCount, 1)) * 3.4
    }
    return timing(lineCount: lineCount, limit: nil).total
  }

  private static func flag(_ options: [String: Any], key: String, default defaultValue: Bool) -> Bool {
    if let value = options[key] as? Bool {
      return value
    }
    if let value = options[key] as? NSNumber {
      return value.boolValue
    }
    return defaultValue
  }

  private static func minTime(_ left: CMTime, _ right: CMTime) -> CMTime {
    CMTimeCompare(left, right) < 0 ? left : right
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
    throw PosterError.message("找不到背景视频，请重新选择")
  }
}
