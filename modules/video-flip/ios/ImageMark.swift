import AVFoundation
import UIKit

struct MarkConfig {
  var text: String
  var fontSize: CGFloat
  var opacity: CGFloat
  var move: Bool
  var placeLeft: Bool
  var placeCenter: Bool
  var flip: Bool
  var crop: CGRect?
}

enum MarkConfigParser {
  static func watermark(from options: [String: Any]) -> MarkConfig? {
    guard let raw = options["watermark"] as? [String: Any] else {
      return nil
    }
    guard bool(raw["enabled"]) else {
      return nil
    }
    let trimmed = (raw["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    var config = MarkConfig(
      text: trimmed.isEmpty ? "南方小猴子" : trimmed,
      fontSize: cg(raw["fontSize"]) ?? 16,
      opacity: cg(raw["opacity"]) ?? 0.25,
      move: bool(raw["move"], default: true),
      placeLeft: bool(raw["placeLeft"], default: true),
      placeCenter: bool(raw["placeCenter"], default: true),
      flip: bool(options["flip"]),
      crop: nil
    )
    if !config.placeLeft && !config.placeCenter {
      config.placeCenter = true
    }
    config.opacity = min(max(config.opacity, 0.08), 0.6)
    config.fontSize = min(max(config.fontSize, 10), 72)
    return config
  }

  static func crop(from options: [String: Any]) -> CGRect? {
    guard let raw = options["crop"] as? [String: Any],
          let x = cg(raw["x"]),
          let y = cg(raw["y"]),
          let width = cg(raw["width"]),
          let height = cg(raw["height"]) else {
      return nil
    }
    let rect = CGRect(x: x, y: y, width: width, height: height).standardized
    guard rect.width > 0.02, rect.height > 0.02 else {
      return nil
    }
    let clamped = CGRect(
      x: min(max(rect.origin.x, 0), 0.98),
      y: min(max(rect.origin.y, 0), 0.98),
      width: min(max(rect.width, 0.02), 1),
      height: min(max(rect.height, 0.02), 1)
    )
    return CGRect(
      x: clamped.origin.x,
      y: clamped.origin.y,
      width: min(clamped.width, 1 - clamped.origin.x),
      height: min(clamped.height, 1 - clamped.origin.y)
    )
  }

  private static func bool(_ value: Any?, default defaultValue: Bool = false) -> Bool {
    if let flag = value as? Bool {
      return flag
    }
    if let number = value as? NSNumber {
      return number.boolValue
    }
    return defaultValue
  }

  private static func cg(_ value: Any?) -> CGFloat? {
    guard let number = value as? NSNumber else {
      return nil
    }
    return CGFloat(truncating: number)
  }
}

enum WatermarkBurner {
  static func apply(
    to composition: AVMutableVideoComposition,
    renderSize: CGSize,
    duration: Double,
    options: [String: Any],
    subtitle: String = "",
    speechDuration: Double = 0
  ) {
    let mark = MarkConfigParser.watermark(from: options)
    let line = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard mark != nil || !line.isEmpty else {
      return
    }
    let safeDuration = duration.isFinite && duration > 0.2 ? duration : 1

    let parent = CALayer()
    let videoLayer = CALayer()
    let canvas = CGRect(origin: .zero, size: renderSize)
    parent.frame = canvas
    videoLayer.frame = canvas
    parent.isGeometryFlipped = true
    parent.masksToBounds = true
    parent.addSublayer(videoLayer)

    if let mark {
      let fontSize = fittedFontSize(mark.fontSize, canvas: renderSize)
      let textSize = measure(mark.text, fontSize: fontSize)
      if mark.placeLeft {
      let preferred = CGPoint(x: 16 + textSize.width / 2, y: renderSize.height / 2)
      parent.addSublayer(textLayer(
        mark: mark,
        fontSize: fontSize,
        textSize: textSize,
        center: place(preferred, textSize: textSize, canvas: renderSize),
        canvas: renderSize,
        phase: 0.4,
        duration: safeDuration
      ))
    }
    if mark.placeCenter {
      let preferred = CGPoint(x: renderSize.width / 2, y: renderSize.height / 2)
      parent.addSublayer(textLayer(
        mark: mark,
        fontSize: fontSize,
        textSize: textSize,
        center: place(preferred, textSize: textSize, canvas: renderSize),
        canvas: renderSize,
        phase: 1.7,
        duration: safeDuration
      ))
      }
    }
    if !line.isEmpty {
      parent.addSublayer(subtitleLayer(text: line, canvas: renderSize, duration: safeDuration, speechDuration: speechDuration))
    }

    composition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)
  }

  private static func subtitleLayer(text: String, canvas: CGSize, duration: Double, speechDuration: Double) -> CALayer {
    let fontSize = max(18, min(canvas.height * 0.042, 42))
    let font = UIFont(name: "PingFangSC-Medium", size: fontSize) ?? UIFont.systemFont(ofSize: fontSize, weight: .medium)
    let maxTextWidth = max(40, canvas.width - 48)
    let bounds = (text as NSString).boundingRect(
      with: CGSize(width: maxTextWidth, height: canvas.height * 0.28),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: [.font: font],
      context: nil
    )
    let box = CGSize(width: min(canvas.width - 24, ceil(bounds.width) + 20), height: ceil(bounds.height) + 14)
    let container = CALayer()
    container.bounds = CGRect(origin: .zero, size: box)
    container.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    container.position = CGPoint(x: canvas.width / 2, y: canvas.height - 16 - box.height / 2)
    container.backgroundColor = UIColor.black.withAlphaComponent(0.45).cgColor
    container.cornerRadius = 8
    container.masksToBounds = true

    let textLayer = CATextLayer()
    textLayer.frame = container.bounds.insetBy(dx: 8, dy: 6)
    textLayer.string = text
    if let cgFont = CGFont(font.fontName as CFString) {
      textLayer.font = cgFont
    }
    textLayer.fontSize = fontSize
    textLayer.foregroundColor = UIColor.white.cgColor
    textLayer.alignmentMode = .center
    textLayer.isWrapped = true
    textLayer.contentsScale = 2
    container.addSublayer(textLayer)
    holdSubtitle(container, videoDuration: duration, speechDuration: speechDuration)
    return container
  }

  private static func holdSubtitle(_ layer: CALayer, videoDuration: Double, speechDuration: Double) {
    let video = max(videoDuration, 0.2)
    let speech = min(max(speechDuration, 0.2), video)
    if video - speech < 0.2 {
      layer.opacity = 1
      return
    }
    let end = min(max(speech / video, 0.02), 0.97)
    let hide = min(end + 0.02, 1)
    let animation = CAKeyframeAnimation(keyPath: "opacity")
    animation.values = [1, 1, 0]
    animation.keyTimes = [0, NSNumber(value: end), NSNumber(value: hide)]
    animation.duration = video
    animation.beginTime = AVCoreAnimationBeginTimeAtZero
    animation.isRemovedOnCompletion = false
    animation.fillMode = .forwards
    layer.opacity = 0
    layer.add(animation, forKey: "subtitle-hold")
  }

  private static func textLayer(
    mark: MarkConfig,
    fontSize: CGFloat,
    textSize: CGSize,
    center: CGPoint,
    canvas: CGSize,
    phase: Double,
    duration: Double
  ) -> CATextLayer {
    let layer = CATextLayer()
    let uiFont = UIFont(name: "PingFangSC-Regular", size: fontSize) ?? UIFont.systemFont(ofSize: fontSize)
    layer.string = mark.text
    if let cgFont = CGFont(uiFont.fontName as CFString) {
      layer.font = cgFont
    }
    layer.fontSize = fontSize
    layer.foregroundColor = UIColor.white.cgColor
    layer.alignmentMode = .center
    layer.contentsScale = 2
    layer.opacity = Float(mark.opacity)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.45
    layer.shadowRadius = 1.5
    layer.shadowOffset = .zero
    layer.bounds = CGRect(origin: .zero, size: textSize)
    layer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    layer.position = center
    if mark.move {
      layer.add(wander(around: center, textSize: textSize, canvas: canvas, phase: phase, duration: duration), forKey: "wander")
    }
    return layer
  }

  private static func wander(
    around point: CGPoint,
    textSize: CGSize,
    canvas host: CGSize,
    phase: Double,
    duration: Double
  ) -> CAKeyframeAnimation {
    let ax = host.width * 0.035
    let ay = host.height * 0.028
    var points: [CGPoint] = []
    for index in 0..<8 {
      let t = Double(index) / 7
      let ox = CGFloat(sin(t * .pi * 2 + phase)) * ax + CGFloat(cos(t * .pi * 4 + phase)) * ax * 0.35
      let oy = CGFloat(cos(t * .pi * 2 + phase)) * ay
      let next = CGPoint(x: point.x + ox, y: point.y + oy)
      points.append(place(next, textSize: textSize, canvas: host))
    }
    let animation = CAKeyframeAnimation(keyPath: "position")
    animation.values = points.map { NSValue(cgPoint: $0) }
    animation.duration = max(duration, 0.8)
    animation.beginTime = AVCoreAnimationBeginTimeAtZero
    animation.isRemovedOnCompletion = false
    animation.fillMode = .forwards
    animation.calculationMode = .linear
    return animation
  }

  private static func measure(_ text: String, fontSize: CGFloat) -> CGSize {
    let font = UIFont(name: "PingFangSC-Regular", size: fontSize) ?? UIFont.systemFont(ofSize: fontSize)
    let size = (text as NSString).size(withAttributes: [.font: font])
    return CGSize(width: ceil(size.width + 12), height: ceil(size.height + 8))
  }

  private static func fittedFontSize(_ requested: CGFloat, canvas: CGSize) -> CGFloat {
    let cap = max(12, min(canvas.width, canvas.height) * 0.12)
    return min(max(requested, 10), cap)
  }

  private static func place(_ preferred: CGPoint, textSize: CGSize, canvas: CGSize) -> CGPoint {
    let halfW = textSize.width / 2
    let halfH = textSize.height / 2
    guard canvas.width > textSize.width, canvas.height > textSize.height else {
      return CGPoint(x: canvas.width / 2, y: canvas.height / 2)
    }
    return CGPoint(
      x: min(max(preferred.x, halfW), canvas.width - halfW),
      y: min(max(preferred.y, halfH), canvas.height - halfH)
    )
  }
}

enum ImageMarkError: LocalizedError {
  case badSource
  case downloadFailed
  case unreadable
  case exportFailed

  var errorDescription: String? {
    switch self {
    case .badSource:
      return "找不到这张图片"
    case .downloadFailed:
      return "图片下载失败"
    case .unreadable:
      return "这张图片无法读取"
    case .exportFailed:
      return "图片处理失败"
    }
  }
}

enum ImageMark {
  static func process(uri: String, options: [String: Any]) async throws -> String {
    let loaded = try await loadImage(uri: uri)
    var image = limit(loaded, maxSide: 4096)
    if let crop = MarkConfigParser.crop(from: options) {
      image = cropped(image, norm: crop)
    }
    if bool(options["flip"]) {
      image = flipped(image)
    }
    if let mark = MarkConfigParser.watermark(from: options) {
      image = watermarked(image, mark: mark)
    }
    guard let data = image.jpegData(compressionQuality: 0.92) else {
      throw ImageMarkError.exportFailed
    }
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("marked-\(UUID().uuidString).jpg")
    try data.write(to: output, options: .atomic)
    return output.absoluteString
  }

  private static func loadImage(uri: String) async throws -> UIImage {
    let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
      guard let remote = URL(string: trimmed) else {
        throw ImageMarkError.badSource
      }
      var request = URLRequest(url: remote)
      request.timeoutInterval = 60
      request.setValue("VideoFlip/1.2", forHTTPHeaderField: "User-Agent")
      let fileURL: URL
      let response: URLResponse
      do {
        (fileURL, response) = try await URLSession.shared.download(for: request)
      } catch {
        throw ImageMarkError.downloadFailed
      }
      defer { try? FileManager.default.removeItem(at: fileURL) }
      if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
        throw ImageMarkError.downloadFailed
      }
      let data = try Data(contentsOf: fileURL)
      guard let image = UIImage(data: data) else {
        throw ImageMarkError.unreadable
      }
      return image
    }

    let local = try resolve(trimmed)
    let accessed = local.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        local.stopAccessingSecurityScopedResource()
      }
    }
    guard FileManager.default.fileExists(atPath: local.path) else {
      throw ImageMarkError.badSource
    }
    let data = try Data(contentsOf: local)
    guard let image = UIImage(data: data) else {
      throw ImageMarkError.unreadable
    }
    return image
  }

  private static func limit(_ image: UIImage, maxSide: CGFloat) -> UIImage {
    let longSide = max(image.size.width, image.size.height)
    guard longSide > maxSide, longSide > 0 else {
      return image
    }
    let scale = maxSide / longSide
    let size = CGSize(width: floor(image.size.width * scale), height: floor(image.size.height * scale))
    return render(size: size, scale: 1, opaque: true) { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private static func cropped(_ image: UIImage, norm: CGRect) -> UIImage {
    var rect = CGRect(
      x: norm.origin.x * image.size.width,
      y: norm.origin.y * image.size.height,
      width: norm.width * image.size.width,
      height: norm.height * image.size.height
    ).integral
    rect = rect.intersection(CGRect(origin: .zero, size: image.size))
    guard rect.width >= 2, rect.height >= 2 else {
      return image
    }
    return render(size: rect.size, scale: image.scale, opaque: true) { _ in
      image.draw(at: CGPoint(x: -rect.origin.x, y: -rect.origin.y))
    }
  }

  private static func flipped(_ image: UIImage) -> UIImage {
    render(size: image.size, scale: image.scale, opaque: true) { context in
      context.translateBy(x: image.size.width, y: 0)
      context.scaleBy(x: -1, y: 1)
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }

  private static func watermarked(_ image: UIImage, mark: MarkConfig) -> UIImage {
    let fontSize = min(max(mark.fontSize, 10), max(12, min(image.size.width, image.size.height) * 0.12))
    let font = UIFont(name: "PingFangSC-Regular", size: fontSize) ?? UIFont.systemFont(ofSize: fontSize)
    let textSize = (mark.text as NSString).size(withAttributes: [.font: font])
    let jitterX = mark.move ? CGFloat.random(in: -image.size.width * 0.03...image.size.width * 0.03) : 0
    let jitterY = mark.move ? CGFloat.random(in: -image.size.height * 0.025...image.size.height * 0.025) : 0
    return render(size: image.size, scale: image.scale, opaque: true) { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
      let color = UIColor.white.withAlphaComponent(mark.opacity)
      let shadow = NSShadow()
      shadow.shadowColor = UIColor.black.withAlphaComponent(0.35)
      shadow.shadowBlurRadius = 1.5
      shadow.shadowOffset = .zero
      let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
        .shadow: shadow,
      ]
      if mark.placeLeft {
        let point = CGPoint(
          x: clamp(12 + jitterX, min: 4, max: image.size.width - textSize.width - 4),
          y: clamp((image.size.height - textSize.height) / 2 + jitterY, min: 4, max: image.size.height - textSize.height - 4)
        )
        (mark.text as NSString).draw(at: point, withAttributes: attrs)
      }
      if mark.placeCenter {
        let point = CGPoint(
          x: clamp((image.size.width - textSize.width) / 2 + jitterX * 0.5, min: 4, max: image.size.width - textSize.width - 4),
          y: clamp((image.size.height - textSize.height) / 2 - jitterY * 0.5, min: 4, max: image.size.height - textSize.height - 4)
        )
        (mark.text as NSString).draw(at: point, withAttributes: attrs)
      }
    }
  }

  private static func render(
    size: CGSize,
    scale: CGFloat,
    opaque: Bool,
    draw: (CGContext) -> Void
  ) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale > 0 ? scale : 1
    format.opaque = opaque
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    return renderer.image { context in
      draw(context.cgContext)
    }
  }

  private static func clamp(_ value: CGFloat, min lower: CGFloat, max upper: CGFloat) -> CGFloat {
    if upper < lower {
      return lower
    }
    return min(max(value, lower), upper)
  }

  private static func bool(_ value: Any?) -> Bool {
    if let flag = value as? Bool {
      return flag
    }
    if let number = value as? NSNumber {
      return number.boolValue
    }
    return false
  }

  private static func resolve(_ uri: String) throws -> URL {
    if uri.hasPrefix("/") {
      return URL(fileURLWithPath: uri)
    }
    if let url = URL(string: uri), url.isFileURL {
      return url
    }
    if uri.hasPrefix("file://") {
      let raw = String(uri.dropFirst("file://".count))
      return URL(fileURLWithPath: raw.removingPercentEncoding ?? raw)
    }
    throw ImageMarkError.badSource
  }

  static func sampleFrames(uri: String, count: Int) async throws -> [String] {
    let url = try resolve(uri.trimmingCharacters(in: .whitespacesAndNewlines))
    let accessed = url.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        url.stopAccessingSecurityScopedResource()
      }
    }
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    guard duration > 0.2 else {
      throw ImageMarkError.unreadable
    }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)
    let total = min(max(count, 1), 8)
    var urls: [String] = []
    for _ in 0..<total {
      let seconds = Double.random(in: 0.05...(max(duration - 0.05, 0.06)))
      let image: CGImage
      do {
        image = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
      } catch {
        continue
      }
      guard let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.9) else {
        continue
      }
      let output = FileManager.default.temporaryDirectory.appendingPathComponent("frame-\(UUID().uuidString).jpg")
      try data.write(to: output, options: .atomic)
      urls.append(output.absoluteString)
    }
    guard !urls.isEmpty else {
      throw ImageMarkError.exportFailed
    }
    return urls
  }
}
