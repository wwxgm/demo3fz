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
  static func make(script: String, backgroundUri: String) async throws -> String {
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
      let seconds = ranked
        ? 1.2 + Double(max(cards.filter { $0.rank }.count, 1)) * 3.4
        : timing(lineCount: rows.count, limit: nil).total
      let size = CGSize(width: 1080, height: 1920)
      let url = try await writeBlack(size: size, seconds: seconds)
      baseFile = url
      source = AVURLAsset(url: url)
      renderSize = size
      transform = .identity
      timeline = CMTime(seconds: seconds, preferredTimescale: 600)
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
      timeline = range.duration
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
    let insert = CMTimeRange(start: sourceRange.start, duration: minTime(sourceRange.duration, timeline))
    try compositionVideo.insertTimeRange(insert, of: videoTrack, at: .zero)
    compositionVideo.preferredTransform = .identity
    if let audio = try await source.loadTracks(withMediaType: .audio).first,
       let compositionAudio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audio.load(.timeRange)
      let overlap = insert.intersection(audioRange)
      if overlap.duration.isValid, overlap.duration.seconds > 0.02 {
        try? compositionAudio.insertTimeRange(overlap, of: audio, at: .zero)
      }
    }

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: insert.duration)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideo)
    layerInstruction.setTransform(transform, at: .zero)
    instruction.layerInstructions = [layerInstruction]

    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    videoComposition.sourceTrackIDForFrameTiming = compositionVideo.trackID
    if ranked {
      burnRanking(cards, into: videoComposition, renderSize: renderSize, duration: insert.duration.seconds)
    } else {
      burn(rows, into: videoComposition, renderSize: renderSize, duration: insert.duration.seconds)
    }

    let output = FileManager.default.temporaryDirectory.appendingPathComponent("poster-\(UUID().uuidString).mp4")
    try await export(composition: composition, videoComposition: videoComposition, output: output)
    return output.absoluteString
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
    parent.masksToBounds = true
    var perspective = CATransform3DIdentity
    perspective.m34 = -1 / 700
    parent.sublayerTransform = perspective
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
      .strokeColor: UIColor.black,
      .strokeWidth: -6,
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
    return (text, CGSize(width: width, height: ceil(bounds.height) + 8))
  }

  private static func textLayer(_ string: NSAttributedString, size: CGSize) -> CATextLayer {
    let layer = CATextLayer()
    layer.string = string
    layer.alignmentMode = .center
    layer.contentsScale = 2
    layer.isWrapped = true
    layer.bounds = CGRect(origin: .zero, size: size)
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
    return CGSize(width: width, height: ceil(bounds.height) + 8)
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
    parent.masksToBounds = true
    var perspective = CATransform3DIdentity
    perspective.m34 = -1 / 700
    parent.sublayerTransform = perspective
    parent.addSublayer(videoLayer)

    let totalHeight = fitted.sizes.reduce(0) { $0 + $1.height } + fitted.gap * CGFloat(max(rows.count - 1, 0))
    var top = (renderSize.height - totalHeight) / 2
    for (index, row) in rows.enumerated() {
      let box = fitted.sizes[index]
      let layer = CATextLayer()
      layer.string = styled(row, font: fitted.font)
      layer.alignmentMode = .center
      layer.contentsScale = 2
      layer.isWrapped = false
      layer.bounds = CGRect(origin: .zero, size: box)
      layer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
      layer.position = CGPoint(x: renderSize.width / 2, y: top + box.height / 2)
      layer.shadowColor = UIColor.black.cgColor
      layer.shadowOpacity = 0.85
      layer.shadowRadius = max(4, fitted.font.pointSize * 0.06)
      layer.shadowOffset = .zero
      flip(layer, delay: clock.gap * Double(index), duration: clock.flip)
      parent.addSublayer(layer)
      top += box.height + fitted.gap
    }

    composition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)
  }

  private static func spinIn(_ layer: CALayer, delay: Double) {
    layer.transform = CATransform3DMakeRotation(-.pi / 2, 1, 0, 0)
    let spin = CABasicAnimation(keyPath: "transform.rotation.x")
    spin.fromValue = -Double.pi / 2
    spin.toValue = 0
    spin.duration = 0.34
    spin.beginTime = AVCoreAnimationBeginTimeAtZero + delay
    spin.timingFunction = CAMediaTimingFunction(name: .easeOut)
    spin.fillMode = .both
    spin.isRemovedOnCompletion = false
    layer.add(spin, forKey: "poster-flip")
  }

  private static func flip(_ layer: CALayer, delay: Double, duration: Double) {
    layer.transform = CATransform3DMakeRotation(-.pi / 2, 1, 0, 0)
    layer.opacity = 0
    let spin = CABasicAnimation(keyPath: "transform.rotation.x")
    spin.fromValue = -Double.pi / 2
    spin.toValue = 0
    spin.duration = max(duration, 0.12)
    spin.beginTime = AVCoreAnimationBeginTimeAtZero + delay
    spin.timingFunction = CAMediaTimingFunction(name: .easeOut)
    spin.fillMode = .both
    spin.isRemovedOnCompletion = false
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0
    fade.toValue = 1
    fade.duration = max(duration * 0.65, 0.08)
    fade.beginTime = AVCoreAnimationBeginTimeAtZero + delay
    fade.fillMode = .both
    fade.isRemovedOnCompletion = false
    layer.add(spin, forKey: "poster-flip")
    layer.add(fade, forKey: "poster-fade")
  }

  private static func styled(_ text: String, font: UIFont) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    return NSAttributedString(string: text, attributes: [
      .font: font,
      .foregroundColor: UIColor.white,
      .strokeColor: UIColor.black,
      .strokeWidth: -8,
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
    let pad = font.pointSize * 0.28
    return CGSize(width: ceil(size.width + pad), height: ceil(size.height + font.pointSize * 0.12))
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
    let preset = preferred.first(where: { compatible.contains($0) }) ?? AVAssetExportPresetHighestQuality
    guard let session = AVAssetExportSession(asset: composition, presetName: preset) else {
      throw PosterError.message("系统无法导出大字报")
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
          continuation.resume(throwing: PosterError.message("制作已取消"))
        default:
          continuation.resume(throwing: PosterError.message(session.error?.localizedDescription ?? "制作失败"))
        }
      }
    }
    guard FileManager.default.fileExists(atPath: output.path) else {
      throw PosterError.message("制作完成但没有生成文件")
    }
  }

  private static func evenSize(_ size: CGSize) -> CGSize {
    func even(_ value: CGFloat) -> CGFloat {
      let rounded = max(2, Int(value.rounded()))
      let next = rounded % 2 == 0 ? rounded : rounded - 1
      return CGFloat(max(2, next))
    }
    return CGSize(width: even(size.width), height: even(size.height))
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
