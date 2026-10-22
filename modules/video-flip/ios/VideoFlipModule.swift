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

    AsyncFunction("frameAt") { (uri: String, seconds: Double) async throws -> String in
      try await ImageMark.frameAt(uri: uri, seconds: seconds)
    }

    AsyncFunction("coverSmear") { (uri: String, options: [String: Any]) async throws -> String in
      try await Smear.cover(uri: uri, options: options)
    }

    AsyncFunction("joinVideos") { (uris: [String]) async throws -> String in
      try await Concat.join(uris: uris)
    }

    AsyncFunction("makePoster") { (script: String, backgroundUri: String, options: [String: Any]) async throws -> String in
      try await PosterMaker.make(script: script, backgroundUri: backgroundUri, options: options)
    }

    AsyncFunction("loadPage") { (url: String, referer: String) async throws -> String in
      try await PageLoader.load(url: url, referer: referer)
    }

    Function("removeTempFile") { (uri: String) in
      VideoFlipper.removeTempFile(uri: uri)
    }

    Function("clearProcessingCache") { () -> Double in
      VideoFlipper.clearProcessingCache()
    }
  }
}

private enum PageLoadError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

private enum PageLoader {
  static func load(url: String, referer: String) async throws -> String {
    guard let target = URL(string: url) else {
      throw PageLoadError.message("搜索地址无效")
    }
    var request = URLRequest(url: target)
    request.timeoutInterval = 30
    request.setValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      forHTTPHeaderField: "User-Agent"
    )
    if !referer.isEmpty {
      request.setValue(referer, forHTTPHeaderField: "Referer")
    }
    request.setValue("zh-CN,zh;q=0.9", forHTTPHeaderField: "Accept-Language")
    request.setValue("application/json,text/plain,text/html,*/*", forHTTPHeaderField: "Accept")
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      throw PageLoadError.message("没有连上搜索接口")
    }
    if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
      throw PageLoadError.message("接口返回 HTTP \(http.statusCode)")
    }
    if let text = String(data: data, encoding: .utf8) {
      return text
    }
    let gbk = String.Encoding(
      rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
    )
    if let text = String(data: data, encoding: gbk) {
      return text
    }
    throw PageLoadError.message("搜索结果无法读取")
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

func applyRec709(_ composition: AVMutableVideoComposition) {
  composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
  composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
  composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
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
    let cut = try Self.parseCut(options)
    if let cut {
      try Self.validateCut(cut, duration: sourceRange.duration.seconds)
    }
    let extend = Self.parseExtend(options)
    let timeline: ClipTimeline.Result
    if let extend {
      timeline = try await ClipTimeline.build(
        video: videoTrack,
        audio: sourceAudio,
        sourceStart: sourceRange.start,
        sourceDuration: sourceRange.duration,
        extend: extend,
        skip: cut.map { Self.skipRange($0, sourceStart: sourceRange.start, duration: sourceRange.duration) }
      )
    } else {
      timeline = try await Self.plainTimeline(video: videoTrack, audio: sourceAudio, sourceRange: sourceRange)
    }
    let composition = timeline.composition
    let compositionVideoTrack = timeline.videoTrack
    var originalAudioTrack = timeline.audioTrack
    var timelineDuration = timeline.duration
    if extend == nil, let cut {
      let keptAudio = try await excise(
        composition: composition,
        video: compositionVideoTrack,
        audio: originalAudioTrack,
        start: cut.start,
        end: cut.end
      )
      if !keptAudio {
        originalAudioTrack = nil
      }
      let updated = try await compositionVideoTrack.load(.timeRange)
      timelineDuration = updated.duration
    }

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

    let composedRange = try await compositionVideoTrack.load(.timeRange)
    let safeDuration = try alignToFrames(
      video: compositionVideoTrack,
      audios: [originalAudioTrack, speechTrack],
      duration: CMTimeMinimum(timelineDuration, composedRange.duration)
    )
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: safeDuration)

    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideoTrack)
    layerInstruction.setTransform(transform, at: .zero)
    if let replay = timeline.replayRange, let ramp = frameRange(replay, limit: safeDuration) {
      let zoomed = zoom(transform, renderSize: renderSize, scale: 1.25)
      layerInstruction.setTransformRamp(fromStart: transform, toEnd: zoomed, timeRange: ramp)
      let reset = CMTimeAdd(ramp.start, ramp.duration)
      if CMTimeCompare(reset, safeDuration) < 0 {
        layerInstruction.setTransform(transform, at: reset)
      }
    }
    instruction.layerInstructions = [layerInstruction]

    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    // 水印和字幕另走一遍。和翻转放在同一次合成里时，系统会报 Operation Stopped。

    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("flipped-\(UUID().uuidString).mp4")
    try await exportVideo(
      composition: composition,
      videoComposition: videoComposition,
      audioMix: audioMix(
        original: originalAudioTrack,
        speech: speechTrack,
        speechDuration: min(speechDuration, max(safeDuration.seconds - 1.0 / 30.0, 0))
      ),
      outputURL: outputURL
    )

    let filterName = Self.filterName(from: options)
    let overlay = Self.needsOverlay(options: options, subtitle: subtitle)
    guard !filterName.isEmpty else {
      if overlay {
        return try await burnOverlay(
          source: outputURL,
          options: options,
          subtitle: subtitle,
          speechDuration: speechDuration
        )
      }
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
    do {
      return try await burnOverlay(
        source: filtered,
        options: options,
        subtitle: subtitle,
        speechDuration: speechDuration
      )
    } catch {
      try? FileManager.default.removeItem(at: filtered)
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
    var compositionAudio: AVMutableCompositionTrack?
    if let audioTrack = try await asset.loadTracks(withMediaType: .audio).first,
       let audio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audioTrack.load(.timeRange)
      let usable = CMTimeMinimum(range.duration, audioRange.duration)
      if usable.isValid, usable.seconds > 0.02 {
        try? audio.insertTimeRange(CMTimeRange(start: audioRange.start, duration: usable), of: audioTrack, at: .zero)
        compositionAudio = audio
      }
    }
    _ = try alignToFrames(video: compositionVideo, audios: [compositionAudio], duration: range.duration)
    let videoComposition = LookFilter.composition(asset: composition, name: name)
    try await exportVideo(
      composition: composition,
      videoComposition: videoComposition,
      audioMix: nil,
      outputURL: output
    )
  }

  private static func burnOverlay(
    source: URL,
    options: [String: Any],
    subtitle: String,
    speechDuration: Double
  ) async throws -> String {
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
    var compositionAudio: AVMutableCompositionTrack?
    if let audioTrack = try await asset.loadTracks(withMediaType: .audio).first,
       let audio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
       ) {
      let audioRange = try await audioTrack.load(.timeRange)
      try? audio.insertTimeRange(audioRange, of: audioTrack, at: .zero)
      compositionAudio = audio
    }
    let duration = try alignToFrames(
      video: compositionVideo,
      audios: [compositionAudio],
      duration: range.duration
    )
    let naturalSize = try await videoTrack.load(.naturalSize)
    let preferred = try await videoTrack.load(.preferredTransform)
    let oriented = CGRect(origin: .zero, size: naturalSize).applying(preferred)
    let upright = preferred.concatenating(
      CGAffineTransform(translationX: -oriented.origin.x, y: -oriented.origin.y)
    )
    let renderSize = CGSize(width: evenPixel(abs(oriented.width)), height: evenPixel(abs(oriented.height)))
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideo)
    layerInstruction.setTransform(upright, at: .zero)
    instruction.layerInstructions = [layerInstruction]
    let videoComposition = AVMutableVideoComposition()
    videoComposition.instructions = [instruction]
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    WatermarkBurner.apply(
      to: videoComposition,
      renderSize: renderSize,
      duration: duration.seconds,
      options: options,
      subtitle: subtitle,
      speechDuration: speechDuration
    )
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("flipped-text-\(UUID().uuidString).mp4")
    try await exportVideo(
      composition: composition,
      videoComposition: videoComposition,
      audioMix: nil,
      outputURL: output
    )
    try? FileManager.default.removeItem(at: source)
    return output.absoluteString
  }

  private static func alignToFrames(
    video: AVMutableCompositionTrack,
    audios: [AVMutableCompositionTrack?],
    duration: CMTime
  ) async throws -> CMTime {
    let frames = max(Int(floor(duration.seconds * 30.0)), 1)
    let aligned = CMTime(value: CMTimeValue(frames), timescale: 30)
    let videoRange = try await video.load(.timeRange)
    trim(video, range: videoRange, to: aligned)
    for audio in audios {
      guard let audio else { continue }
      let audioRange = try await audio.load(.timeRange)
      trim(audio, range: audioRange, to: aligned)
    }
    return aligned
  }

  private static func frameRange(_ range: CMTimeRange, limit: CMTime) -> CMTimeRange? {
    let end = CMTimeAdd(range.start, range.duration)
    let limitFrame = max(Int(floor(limit.seconds * 30.0 + 0.0001)), 0)
    let startFrame = min(max(Int(ceil(range.start.seconds * 30.0 - 0.0001)), 0), limitFrame)
    var endFrame = min(max(Int(floor(end.seconds * 30.0 + 0.0001)), startFrame), limitFrame)
    if endFrame >= limitFrame {
      endFrame = max(startFrame, limitFrame - 1)
    }
    guard endFrame - startFrame >= 2 else {
      return nil
    }
    let startTime = CMTime(value: CMTimeValue(startFrame), timescale: 30)
    let endTime = CMTime(value: CMTimeValue(endFrame), timescale: 30)
    return CMTimeRange(start: startTime, duration: CMTimeSubtract(endTime, startTime))
  }

  private static func trim(_ track: AVMutableCompositionTrack, range: CMTimeRange, to aligned: CMTime) {
    let end = CMTimeAdd(range.start, range.duration)
    guard CMTimeCompare(end, aligned) > 0 else { return }
    let start = CMTimeMaximum(aligned, range.start)
    guard CMTimeCompare(end, start) > 0 else { return }
    track.removeTimeRange(CMTimeRange(start: start, duration: CMTimeSubtract(end, start)))
  }

  private static func exportVideo(
    composition: AVMutableComposition,
    videoComposition: AVVideoComposition,
    audioMix: AVMutableAudioMix?,
    outputURL: URL
  ) async throws {
    if FileManager.default.fileExists(atPath: outputURL.path) {
      try? FileManager.default.removeItem(at: outputURL)
    }
    let compatible = AVAssetExportSession.exportPresets(compatibleWith: composition)
    let preferredPresets = [
      AVAssetExportPresetHighestQuality,
      AVAssetExportPreset1920x1080,
      AVAssetExportPreset1280x720,
      AVAssetExportPresetMediumQuality,
    ]
    var presets = preferredPresets.filter { compatible.contains($0) }
    if presets.isEmpty {
      presets = preferredPresets
    }
    var last = "导出失败"
    for preset in presets {
      if FileManager.default.fileExists(atPath: outputURL.path) {
        try? FileManager.default.removeItem(at: outputURL)
      }
      guard let exportSession = AVAssetExportSession(asset: composition, presetName: preset) else {
        last = "系统无法导出这个视频"
        continue
      }
      exportSession.outputURL = outputURL
      exportSession.outputFileType = .mp4
      exportSession.videoComposition = videoComposition
      exportSession.audioMix = audioMix
      exportSession.shouldOptimizeForNetworkUse = false
      let failure: String? = await withCheckedContinuation { continuation in
        exportSession.exportAsynchronously {
          switch exportSession.status {
          case .completed:
            continuation.resume(returning: nil)
          case .cancelled:
            continuation.resume(returning: "翻转已取消")
          default:
            continuation.resume(returning: exportMessage(exportSession.error))
          }
        }
      }
      if failure == nil, FileManager.default.fileExists(atPath: outputURL.path) {
        return
      }
      if failure == "翻转已取消" {
        throw VideoFlipError.exportFailed("翻转已取消")
      }
      last = failure ?? "翻转完成但没有生成文件"
      try? FileManager.default.removeItem(at: outputURL)
    }
    throw VideoFlipError.exportFailed(last)
  }

  private static func exportMessage(_ error: Error?) -> String {
    guard let error else {
      return "导出失败"
    }
    let ns = error as NSError
    if ns.domain == AVFoundationErrorDomain {
      if ns.code == -11880 {
        return "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"
      }
      if ns.code == -11841 {
        return "画面合成不合法（-11841）。请重试这一条。"
      }
      return "\(error.localizedDescription)（\(ns.code)）"
    }
    return error.localizedDescription
  }

  private static func parseCut(_ options: [String: Any]) throws -> (start: Double, end: Double)? {
    guard let raw = options["cut"] as? [String: Any] else {
      return nil
    }
    guard let start = doubleValue(raw["start"]), let end = doubleValue(raw["end"]) else {
      throw VideoFlipError.exportFailed("请填写要移除的开始和结束时间")
    }
    return (start, end)
  }

  private static func validateCut(_ cut: (start: Double, end: Double), duration: Double) throws {
    guard cut.start.isFinite, cut.end.isFinite, cut.start >= 0, cut.end > cut.start + 0.04 else {
      throw VideoFlipError.exportFailed("移除的开始时间要小于结束时间")
    }
    guard cut.start < duration - 0.04 else {
      throw VideoFlipError.exportFailed("移除的开始时间已经超出这条视频")
    }
    let clippedEnd = min(cut.end, duration)
    guard duration - (clippedEnd - cut.start) > 0.2 else {
      throw VideoFlipError.exportFailed("不能把整段视频都剪掉")
    }
  }

  private static func skipRange(
    _ cut: (start: Double, end: Double),
    sourceStart: CMTime,
    duration: CMTime
  ) -> CMTimeRange {
    let clippedEnd = min(cut.end, duration.seconds)
    return CMTimeRange(
      start: CMTimeAdd(sourceStart, CMTime(seconds: cut.start, preferredTimescale: 600)),
      duration: CMTime(seconds: clippedEnd - cut.start, preferredTimescale: 600)
    )
  }

  private static func excise(
    composition: AVMutableComposition,
    video: AVMutableCompositionTrack,
    audio: AVMutableCompositionTrack?,
    start: Double,
    end: Double
  ) async throws -> Bool {
    let range = try await video.load(.timeRange)
    let clippedEnd = min(end, range.duration.seconds)
    let remove = CMTimeRange(
      start: CMTime(seconds: range.start.seconds + start, preferredTimescale: 600),
      duration: CMTime(seconds: clippedEnd - start, preferredTimescale: 600)
    )
    video.removeTimeRange(remove)
    guard let audio else {
      return false
    }
    let audioRange = try await audio.load(.timeRange)
    let piece = remove.intersection(audioRange)
    if piece.isValid, piece.duration.isValid, piece.duration.seconds > 0.001 {
      audio.removeTimeRange(piece)
    }
    let after = try await audio.load(.timeRange)
    if !after.duration.isValid || after.duration.seconds < 0.02 {
      composition.removeTrack(audio)
      return false
    }
    return true
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

  static func clearProcessingCache() -> Double {
    let prefixes = ["flipped-", "joined-", "poster-", "frame-", "marked-", "narration-", "smear-"]
    let extensions: Set<String> = ["mp4", "mov", "m4v", "jpg", "jpeg", "png", "heic", "caf", "m4a"]
    let fileManager = FileManager.default
    var roots = [fileManager.temporaryDirectory]
    if let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first {
      roots.append(caches)
    }
    var freed: Int64 = 0
    for root in roots {
      freed += sweepCache(root, prefixes: prefixes, extensions: extensions, depth: 0)
    }
    URLCache.shared.removeAllCachedResponses()
    return Double(freed)
  }

  private static func sweepCache(
    _ url: URL,
    prefixes: [String],
    extensions: Set<String>,
    depth: Int
  ) -> Int64 {
    if depth > 6 {
      return 0
    }
    let fileManager = FileManager.default
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
      return 0
    }
    if !isDirectory.boolValue {
      let name = url.lastPathComponent
      let matched = prefixes.contains(where: { name.hasPrefix($0) }) || extensions.contains(url.pathExtension.lowercased())
      guard matched else {
        return 0
      }
      let size = (try? fileManager.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
      do {
        try fileManager.removeItem(at: url)
        return size
      } catch {
        return 0
      }
    }
    let children = (try? fileManager.contentsOfDirectory(
      at: url,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    )) ?? []
    var freed: Int64 = 0
    for child in children {
      freed += sweepCache(child, prefixes: prefixes, extensions: extensions, depth: depth + 1)
    }
    return freed
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
