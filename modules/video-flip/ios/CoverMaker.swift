import AVFoundation
import UIKit

private enum CoverError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

enum CoverMaker {
  static func make(uri: String, text: String) async throws -> String {
    let url = try resolve(uri)
    let accessed = url.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        url.stopAccessingSecurityScopedResource()
      }
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw CoverError.message("找不到这个视频，请重新选择")
    }
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    guard duration.isFinite, duration > 0.2 else {
      throw CoverError.message("这个视频太短，做不了封面")
    }
    let display = try await displaySize(asset)
    let chosen = try highlight(asset: asset, duration: duration)
    let full = AVAssetImageGenerator(asset: asset)
    full.appliesPreferredTrackTransform = true
    full.requestedTimeToleranceBefore = CMTime(seconds: 0.08, preferredTimescale: 600)
    full.requestedTimeToleranceAfter = CMTime(seconds: 0.08, preferredTimescale: 600)
    if let cap = cappedSize(display) {
      full.maximumSize = cap
    }
    var image: CGImage?
    for time in chosen {
      if let frame = try? full.copyCGImage(at: CMTime(seconds: time, preferredTimescale: 600), actualTime: nil) {
        image = frame
        break
      }
    }
    guard let image else {
      throw CoverError.message("这个视频里没有能做封面的画面")
    }
    let painted = paint(image, lines: coverLines(text))
    guard let data = painted.jpegData(compressionQuality: 0.92) else {
      throw CoverError.message("封面没有生成")
    }
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("cover-\(UUID().uuidString).jpg")
    try data.write(to: output, options: .atomic)
    return output.absoluteString
  }

  private static func displaySize(_ asset: AVAsset) async throws -> CGSize {
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
      return .zero
    }
    let natural = try await track.load(.naturalSize)
    let transform = try await track.load(.preferredTransform)
    let fitted = natural.applying(transform)
    return CGSize(width: abs(fitted.width), height: abs(fitted.height))
  }

  private static func cappedSize(_ display: CGSize) -> CGSize? {
    let longSide = max(display.width, display.height)
    guard longSide > 32 else { return nil }
    let scale = min(1, 1920 / longSide)
    return CGSize(width: floor(display.width * scale), height: floor(display.height * scale))
  }

  private static func highlight(asset: AVAsset, duration: Double) throws -> [Double] {
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 180, height: 180)
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.35, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.35, preferredTimescale: 600)
    let inset = min(max(duration * 0.12, 0.05), 1.2)
    let start = min(inset, max(duration * 0.35, 0.05))
    let end = max(duration - inset, start)
    let slots = duration < 2.5 ? 3 : 7
    var ranked: [(time: Double, score: Float)] = []
    for index in 0..<slots {
      let progress = slots == 1 ? 0 : Double(index) / Double(slots - 1)
      let time = start + (end - start) * progress
      guard let frame = try? generator.copyCGImage(
        at: CMTime(seconds: time, preferredTimescale: 600),
        actualTime: nil
      ) else { continue }
      ranked.append((time, score(frame)))
    }
    guard !ranked.isEmpty else {
      throw CoverError.message("这个视频里没有能做封面的画面")
    }
    return ranked.sorted { $0.score > $1.score }.map(\.time)
  }

  private static func score(_ image: CGImage) -> Float {
    let width = 48
    let height = 48
    let count = width * height
    let pixels = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
    pixels.initialize(repeating: 0, count: count)
    var context: CGContext? = CGContext(
      data: pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width,
      space: CGColorSpaceCreateDeviceGray(),
      bitmapInfo: CGImageAlphaInfo.none.rawValue
    )
    guard context != nil else {
      pixels.deallocate()
      return 0
    }
    context?.interpolationQuality = .low
    context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    var sum: Float = 0
    var sumSq: Float = 0
    for index in 0..<count {
      let value = Float(pixels[index])
      sum += value
      sumSq += value * value
    }
    let mean = sum / Float(count)
    let variance = max(0, sumSq / Float(count) - mean * mean)
    var edge: Float = 0
    let edgeCount = Float((width - 1) * (height - 1))
    for y in 0..<(height - 1) {
      for x in 0..<(width - 1) {
        let index = y * width + x
        let dx = abs(Int(pixels[index]) - Int(pixels[index + 1]))
        let dy = abs(Int(pixels[index]) - Int(pixels[index + width]))
        edge += Float(dx + dy)
      }
    }
    context = nil
    pixels.deallocate()
    let exposure: Float
    if mean < 18 || mean > 242 {
      exposure = 0.15
    } else if mean < 40 || mean > 220 {
      exposure = 0.55
    } else {
      exposure = 1
    }
    return (sqrt(variance) * 0.65 + (edge / edgeCount) * 0.35) * exposure
  }

  private static func coverLines(_ text: String) -> [String] {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return [] }
    var lines: [String] = []
    for raw in trimmed.split(whereSeparator: \.isNewline) {
      let piece = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if piece.isEmpty { continue }
      if piece.count <= 7 {
        lines.append(String(piece))
      } else {
        var current = ""
        for character in piece {
          if "。！？!?；;，,".contains(character) {
            let line = current.trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty { lines.append(String(line.prefix(8))) }
            current = ""
          } else {
            current.append(character)
            if current.count >= 6 {
              lines.append(String(current.prefix(8)))
              current = ""
            }
          }
          if lines.count >= 4 { return Array(lines.prefix(4)) }
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { lines.append(String(tail.prefix(8))) }
      }
      if lines.count >= 4 { break }
    }
    return Array(lines.prefix(4))
  }

  private static func paint(_ image: CGImage, lines: [String]) -> UIImage {
    let size = CGSize(width: image.width, height: image.height)
    if lines.isEmpty {
      return UIImage(cgImage: image)
    }
    let landscape = size.width > size.height
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    return UIGraphicsImageRenderer(size: size, format: format).image { renderer in
      UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
      let shortSide = min(size.width, size.height)
      var fontSize = floor(shortSide * (landscape ? 0.16 : 0.125))
      fontSize = min(fontSize, landscape ? size.height * 0.22 : size.width * 0.2)
      fontSize = max(fontSize, 36)
      let maxWidth = size.width * 0.88
      var font = UIFont.systemFont(ofSize: fontSize, weight: .black)
      for _ in 0..<6 {
        let padGuess = font.pointSize * 0.2
        let widest = lines.map { textWidth($0, font: font) }.max() ?? 0
        if widest <= maxWidth - padGuess * 2 || font.pointSize <= 36 { break }
        let next = floor(font.pointSize * (maxWidth - padGuess * 2) / max(widest, 1))
        font = UIFont.systemFont(ofSize: max(next, 36), weight: .black)
      }
      let pad = font.pointSize * 0.2
      let lineBox = ceil(font.lineHeight + pad)
      let gap = font.pointSize * 0.06
      let barHeight = max(8, font.pointSize * 0.08)
      let blockHeight = lineBox * CGFloat(lines.count) + gap * CGFloat(max(lines.count - 1, 0)) + font.pointSize * 0.16 + barHeight
      let anchor = size.height * (landscape ? 0.5 : 0.38) - blockHeight / 2
      let top = min(max(anchor, size.height * 0.06), max(size.height - blockHeight - size.height * 0.06, size.height * 0.06))
      let context = renderer.cgContext
      for (index, line) in lines.enumerated() {
        let rect = CGRect(
          x: (size.width - maxWidth) / 2,
          y: top + CGFloat(index) * (lineBox + gap),
          width: maxWidth,
          height: lineBox
        )
        drawLine(line, in: rect, font: font, context: context)
      }
      let barWidth = min(maxWidth * 0.34, font.pointSize * 2.4)
      let barY = top + lineBox * CGFloat(lines.count) + gap * CGFloat(max(lines.count - 1, 0)) + font.pointSize * 0.1
      let bar = CGRect(x: (size.width - barWidth) / 2, y: barY, width: barWidth, height: barHeight)
      context.setFillColor(UIColor.black.cgColor)
      context.fill(bar.insetBy(dx: -3, dy: -3))
      context.setFillColor(UIColor(red: 1, green: 0.86, blue: 0.05, alpha: 1).cgColor)
      context.fill(bar)
    }
  }

  private static func drawLine(_ line: String, in rect: CGRect, font: UIFont, context: CGContext) {
    let yellow = UIColor(red: 1, green: 0.86, blue: 0.05, alpha: 1)
    context.saveGState()
    context.setShadow(
      offset: CGSize(width: 0, height: font.pointSize * 0.05),
      blur: font.pointSize * 0.14,
      color: UIColor.black.withAlphaComponent(0.55).cgColor
    )
    styled(line, font: font, stroke: 22, strokeColor: .black, fill: .clear).draw(in: rect)
    context.restoreGState()
    styled(line, font: font, stroke: 7, strokeColor: .white, fill: .clear).draw(in: rect)
    styled(line, font: font, stroke: 0, strokeColor: .clear, fill: yellow).draw(in: rect)
  }

  private static func styled(
    _ line: String,
    font: UIFont,
    stroke: CGFloat,
    strokeColor: UIColor,
    fill: UIColor
  ) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    var attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .paragraphStyle: paragraph,
      .foregroundColor: fill,
    ]
    if stroke > 0 {
      attributes[.strokeWidth] = stroke
      attributes[.strokeColor] = strokeColor
    }
    return NSAttributedString(string: line, attributes: attributes)
  }

  private static func textWidth(_ line: String, font: UIFont) -> CGFloat {
    let bounds = (line as NSString).size(withAttributes: [.font: font])
    return ceil(bounds.width)
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
    throw CoverError.message("找不到这个视频，请重新选择")
  }
}
