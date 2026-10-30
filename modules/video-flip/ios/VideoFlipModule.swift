import AVFoundation
import ExpoModulesCore

public class VideoFlipModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoFlip")

    Function("prepareFlipBatch") {
      FlipControl.reset()
    }

    Function("flipProgress") { (id: String) -> Double in
      FlipControl.value(id)
    }

    Function("cancelFlip") { (id: String) in
      FlipControl.cancel(id)
    }

    Function("cancelAllFlips") {
      FlipControl.cancelAll()
    }

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

    AsyncFunction("makeCover") { (uri: String, text: String) async throws -> String in
      try await CoverMaker.make(uri: uri, text: text)
    }

    AsyncFunction("coverSmear") { (uri: String, options: [String: Any]) async throws -> String in
      try await Smear.cover(uri: uri, options: options)
    }

    AsyncFunction("coverFace") { (uri: String, options: [String: Any]) async throws -> String in
      try await FaceCover.cover(uri: uri, options: options)
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

    AsyncFunction("stageOriginal") { (uri: String) async throws -> String in
      try VideoFlipper.stageOriginal(uri)
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

private enum FlipControl {
  private static let lock = NSLock()
  private static var progress: [String: Double] = [:]
  private static var cancelled = Set<String>()
  private static var halt = false
  private static var currentJob = ""
  private static var phaseStart = 0.05
  private static var phaseEnd = 0.96
  private static var session: AVAssetExportSession?
  private static var readers: [AVAssetReader] = []
  private static var abortHandlers: [String: () -> Void] = [:]

  static func setAbort(id: String, handler: (() -> Void)?) {
    lock.lock()
    if id.isEmpty {
      lock.unlock()
      return
    }
    if let handler {
      abortHandlers[id] = handler
    } else {
      abortHandlers.removeValue(forKey: id)
    }
    lock.unlock()
  }

  static func reset() {
    lock.lock()
    halt = false
    cancelled.removeAll()
    progress.removeAll()
    currentJob = ""
    let export = session
    let reading = readers
    session = nil
    readers = []
    abortHandlers.removeAll()
    lock.unlock()
    export?.cancelExport()
    reading.forEach { $0.cancelReading() }
  }

  static func begin(_ id: String) {
    guard !id.isEmpty else { return }
    lock.lock()
    let previousId = currentJob
    let switching = !previousId.isEmpty && previousId != id
    let previousSession = previousId == id ? nil : session
    let previousReaders = previousId == id ? [] : readers
    let previousAbort = switching ? abortHandlers[previousId] : nil
    if switching {
      cancelled.insert(previousId)
      readers = []
    }
    currentJob = id
    progress[id] = 0.01
    cancelled.remove(id)
    lock.unlock()
    previousSession?.cancelExport()
    previousReaders.forEach { $0.cancelReading() }
    previousAbort?()
  }

  static func phase(_ start: Double, _ end: Double) {
    lock.lock()
    phaseStart = start
    phaseEnd = end
    lock.unlock()
  }

  static func setProgress(_ id: String, _ value: Double) {
    guard !id.isEmpty else { return }
    lock.lock()
    progress[id] = min(max(value, 0), 0.99)
    lock.unlock()
  }

  static func value(_ id: String) -> Double {
    lock.lock()
    let current = progress[id] ?? 0
    lock.unlock()
    return current
  }

  static func shouldStop(_ id: String) -> Bool {
    lock.lock()
    let job = id.isEmpty ? currentJob : id
    let stop = halt || (!job.isEmpty && cancelled.contains(job))
    lock.unlock()
    return stop
  }

  static func noteExport(_ fraction: Double, job: String) {
    lock.lock()
    let id = job.isEmpty ? currentJob : job
    guard !id.isEmpty, id == currentJob else {
      lock.unlock()
      return
    }
    let start = phaseStart
    let end = phaseEnd
    lock.unlock()
    setProgress(id, start + (end - start) * min(max(fraction, 0), 1))
  }

  static func attach(_ export: AVAssetExportSession, job: String) -> Bool {
    lock.lock()
    let ok = job.isEmpty || currentJob == job
    if ok {
      session = export
    }
    lock.unlock()
    return ok
  }

  static func detach(_ export: AVAssetExportSession) {
    lock.lock()
    if session === export {
      session = nil
    }
    lock.unlock()
  }

  static func track(_ reader: AVAssetReader) {
    lock.lock()
    readers.append(reader)
    lock.unlock()
  }

  static func untrack(_ reader: AVAssetReader) {
    lock.lock()
    readers.removeAll { $0 === reader }
    lock.unlock()
  }

  static func cancel(_ id: String) {
    lock.lock()
    if !id.isEmpty {
      cancelled.insert(id)
    }
    let export = currentJob == id || id.isEmpty ? session : nil
    let reading = currentJob == id || id.isEmpty ? readers : []
    let handler = abortHandlers[id]
    lock.unlock()
    export?.cancelExport()
    reading.forEach { $0.cancelReading() }
    handler?()
  }

  static func cancelAll() {
    lock.lock()
    halt = true
    if !currentJob.isEmpty {
      cancelled.insert(currentJob)
    }
    let export = session
    let reading = readers
    let handlers = Array(abortHandlers.values)
    lock.unlock()
    export?.cancelExport()
    reading.forEach { $0.cancelReading() }
    handlers.forEach { $0() }
  }
}

private final class OnceGate {
  private let lock = NSLock()
  private var done = false

  func run(_ body: () -> Void) {
    lock.lock()
    if done {
      lock.unlock()
      return
    }
    done = true
    lock.unlock()
    body()
  }
}

private enum VideoFlipper {
  static func flipHorizontal(
    uri: String,
    options: [String: Any],
    allowRepack: Bool = true,
    followSourceFrames: Bool = false
  ) async throws -> String {
    let jobId = (options["jobId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if allowRepack {
      FlipControl.begin(jobId)
    }
    if FlipControl.shouldStop(jobId) {
      throw VideoFlipError.exportFailed("翻转已取消")
    }
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
    let safeDuration: CMTime
    if followSourceFrames {
      safeDuration = CMTimeMinimum(timelineDuration, composedRange.duration)
      trim(compositionVideoTrack, range: composedRange, to: safeDuration)
      for audio in [originalAudioTrack, speechTrack] {
        guard let audio else { continue }
        let audioRange = try await audio.load(.timeRange)
        trim(audio, range: audioRange, to: safeDuration)
      }
    } else {
      safeDuration = try await alignToFrames(
        video: compositionVideoTrack,
        audios: [originalAudioTrack, speechTrack],
        duration: CMTimeMinimum(timelineDuration, composedRange.duration)
      )
    }
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
    if followSourceFrames {
      let minFrame = try await compositionVideoTrack.load(.minFrameDuration)
      if minFrame.isValid, minFrame.seconds >= 1.0 / 120.0, minFrame.seconds <= 0.1 {
        videoComposition.frameDuration = minFrame
      } else {
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
      }
      videoComposition.sourceTrackIDForFrameTiming = compositionVideoTrack.trackID
    } else {
      videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    }
    // 水印和字幕另走一遍。和翻转放在同一次合成里时，系统会报 Operation Stopped。
    let filterName = Self.filterName(from: options)
    let overlay = Self.needsOverlay(options: options, subtitle: subtitle)

    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("flipped-\(UUID().uuidString).mp4")
    if FlipControl.shouldStop(jobId) {
      throw VideoFlipError.exportFailed("翻转已取消")
    }
    let laterPass = !filterName.isEmpty || overlay
    FlipControl.phase(0.05, laterPass ? 0.62 : 0.96)
    do {
      try await exportVideo(
        composition: composition,
        videoComposition: videoComposition,
        audioMix: audioMix(
          original: originalAudioTrack,
          speech: speechTrack,
          speechDuration: min(speechDuration, max(safeDuration.seconds - 1.0 / 30.0, 0))
        ),
        outputURL: outputURL,
        jobId: jobId
      )
    } catch {
      guard allowRepack, isBrokenTiming(error) else { throw error }
      let packed: URL
      do {
        packed = try await repackCompressed(sourceURL, jobId: jobId)
      } catch {
        throw VideoFlipError.exportFailed("这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
      }
      defer { try? FileManager.default.removeItem(at: packed) }
      return try await flipHorizontal(
        uri: packed.absoluteString,
        options: options,
        allowRepack: false,
        followSourceFrames: true
      )
    }

    guard !filterName.isEmpty else {
      if overlay {
        FlipControl.phase(0.62, 0.96)
        return try await burnOverlay(
          source: outputURL,
          options: options,
          subtitle: subtitle,
          speechDuration: speechDuration,
          jobId: jobId
        )
      }
      return outputURL.absoluteString
    }

    let filtered = FileManager.default.temporaryDirectory
      .appendingPathComponent("flipped-look-\(UUID().uuidString).mp4")
    do {
      FlipControl.phase(0.62, overlay ? 0.78 : 0.96)
      try await applyLook(source: outputURL, output: filtered, name: filterName, jobId: jobId)
      try? FileManager.default.removeItem(at: outputURL)
    } catch {
      try? FileManager.default.removeItem(at: filtered)
      throw error
    }
    guard overlay else {
      return filtered.absoluteString
    }
    do {
      FlipControl.phase(0.78, 0.96)
      return try await burnOverlay(
        source: filtered,
        options: options,
        subtitle: subtitle,
        speechDuration: speechDuration,
        jobId: jobId
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

  private static func applyLook(source: URL, output: URL, name: String, jobId: String) async throws {
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
    _ = try await alignToFrames(video: compositionVideo, audios: [compositionAudio], duration: range.duration)
    let videoComposition = LookFilter.composition(asset: composition, name: name)
    try await exportVideo(
      composition: composition,
      videoComposition: videoComposition,
      audioMix: nil,
      outputURL: output,
      jobId: jobId
    )
  }

  private static func burnOverlay(
    source: URL,
    options: [String: Any],
    subtitle: String,
    speechDuration: Double,
    jobId: String
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
    let duration = try await alignToFrames(
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
      outputURL: output,
      jobId: jobId
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
    outputURL: URL,
    jobId: String
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
      if FlipControl.shouldStop(jobId) {
        throw VideoFlipError.exportFailed("翻转已取消")
      }
      if FileManager.default.fileExists(atPath: outputURL.path) {
        try? FileManager.default.removeItem(at: outputURL)
      }
      let outcome = await exportOnce(
        composition: composition,
        videoComposition: videoComposition,
        audioMix: audioMix,
        outputURL: outputURL,
        preset: preset,
        jobId: jobId
      )
      if outcome == nil, FileManager.default.fileExists(atPath: outputURL.path) {
        return
      }
      if outcome == "翻转已取消" || outcome == "这一条长时间没有进展，已停止" {
        throw VideoFlipError.exportFailed(outcome ?? "翻转已取消")
      }
      if outcome?.contains("-11880") == true {
        throw VideoFlipError.exportFailed(outcome ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
      }
      last = outcome ?? "翻转完成但没有生成文件"
      try? FileManager.default.removeItem(at: outputURL)
    }
    throw VideoFlipError.exportFailed(last)
  }

  private static func exportOnce(
    composition: AVMutableComposition,
    videoComposition: AVVideoComposition,
    audioMix: AVMutableAudioMix?,
    outputURL: URL,
    preset: String,
    jobId: String
  ) async -> String? {
    await withCheckedContinuation { continuation in
      DispatchQueue.main.async {
        guard let exportSession = AVAssetExportSession(asset: composition, presetName: preset) else {
          continuation.resume(returning: "系统无法导出这个视频")
          return
        }
        exportSession.outputURL = outputURL
        exportSession.outputFileType = .mp4
        exportSession.videoComposition = videoComposition
        exportSession.audioMix = audioMix
        exportSession.shouldOptimizeForNetworkUse = false
        guard FlipControl.attach(exportSession, job: jobId) else {
          continuation.resume(returning: "翻转已取消")
          return
        }
        let gate = OnceGate()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        let cancelSource = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
        var lastProgress: Float = -1
        var lastChange = Date()
        let stopThisExport = {
          exportSession.cancelExport()
          DispatchQueue.main.async {
            gate.run {
              timer.cancel()
              cancelSource.cancel()
              FlipControl.detach(exportSession)
              FlipControl.setAbort(id: jobId, handler: nil)
              continuation.resume(returning: "翻转已取消")
            }
          }
        }
        FlipControl.setAbort(id: jobId, handler: stopThisExport)
        timer.schedule(deadline: .now() + 0.4, repeating: 0.4)
        timer.setEventHandler {
          if FlipControl.shouldStop(jobId) {
            stopThisExport()
            return
          }
          let fraction = exportSession.progress
          if abs(fraction - lastProgress) > 0.002 {
            lastProgress = fraction
            lastChange = Date()
          }
          FlipControl.noteExport(Double(fraction), job: jobId)
          if Date().timeIntervalSince(lastChange) > 60 {
            exportSession.cancelExport()
            gate.run {
              timer.cancel()
              cancelSource.cancel()
              FlipControl.detach(exportSession)
              FlipControl.setAbort(id: jobId, handler: nil)
              continuation.resume(returning: "这一条长时间没有进展，已停止")
            }
          }
        }
        timer.resume()
        cancelSource.schedule(deadline: .now() + 0.2, repeating: 0.2)
        cancelSource.setEventHandler {
          guard FlipControl.shouldStop(jobId) else { return }
          stopThisExport()
        }
        cancelSource.resume()
        exportSession.exportAsynchronously {
          DispatchQueue.main.async {
            gate.run {
              timer.cancel()
              cancelSource.cancel()
              FlipControl.detach(exportSession)
              FlipControl.setAbort(id: jobId, handler: nil)
              switch exportSession.status {
              case .completed:
                continuation.resume(returning: nil)
              case .cancelled:
                if FlipControl.shouldStop(jobId) {
                  continuation.resume(returning: "翻转已取消")
                } else {
                  continuation.resume(returning: "这一条长时间没有进展，已停止")
                }
              default:
                continuation.resume(returning: exportMessage(exportSession.error))
              }
            }
          }
        }
      }
    }
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

  private static func isBrokenTiming(_ error: Error) -> Bool {
    let ns = error as NSError
    if ns.domain == AVFoundationErrorDomain, ns.code == -11880 {
      return true
    }
    return ns.localizedDescription.contains("-11880")
  }

  /// 不抽帧。只把压缩数据按原样重新封装，修掉坏掉的画面索引，再走原来的翻转。
  private static func repackCompressed(_ url: URL, jobId: String) async throws -> URL {
    let asset = AVURLAsset(url: url)
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw VideoFlipError.noVideoTrack
    }
    let videoHints = try await videoTrack.load(.formatDescriptions)
    guard let videoHint = videoHints.first else {
      throw VideoFlipError.exportFailed("这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
    }
    let transform = try await videoTrack.load(.preferredTransform)
    let audioTrack = try await asset.loadTracks(withMediaType: .audio).first
    var audioHint: CMFormatDescription?
    if let audioTrack {
      audioHint = try await audioTrack.load(.formatDescriptions).first
    }

    let output = FileManager.default.temporaryDirectory.appendingPathComponent("flipped-src-\(UUID().uuidString).mp4")
    if FileManager.default.fileExists(atPath: output.path) {
      try? FileManager.default.removeItem(at: output)
    }

    let reader = try AVAssetReader(asset: asset)
    FlipControl.track(reader)
    defer { FlipControl.untrack(reader) }
    let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: nil)
    videoOutput.alwaysCopiesSampleData = true
    guard reader.canAdd(videoOutput) else {
      throw VideoFlipError.exportFailed("这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
    }
    reader.add(videoOutput)
    guard reader.startReading() else {
      throw VideoFlipError.exportFailed(reader.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
    }

    let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: videoHint)
    videoInput.transform = transform
    videoInput.expectsMediaDataInRealTime = false
    guard writer.canAdd(videoInput) else {
      throw VideoFlipError.exportFailed("这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
    }
    writer.add(videoInput)
    var audioInput: AVAssetWriterInput?
    if let audioHint, audioTrack != nil {
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: audioHint)
      input.expectsMediaDataInRealTime = false
      if writer.canAdd(input) {
        writer.add(input)
        audioInput = input
      }
    }
    guard writer.startWriting() else {
      throw VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
    }
    guard let first = videoOutput.copyNextSampleBuffer() else {
      writer.cancelWriting()
      try? FileManager.default.removeItem(at: output)
      throw VideoFlipError.exportFailed(reader.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
    }
    let start = CMSampleBufferGetPresentationTimeStamp(first)
    let sessionStart = start.flags.contains(.valid) && start.seconds.isFinite ? start : CMTime.zero
    writer.startSession(atSourceTime: sessionStart)

    do {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let gate = OnceGate()
        let end: (Error?) -> Void = { error in
          gate.run {
            if let error {
              continuation.resume(throwing: error)
            } else {
              continuation.resume()
            }
          }
        }
        let queue = DispatchQueue(label: "flip.repack")
        var finished = false
        var pending: CMSampleBuffer? = first
        var wroteVideo = false
        videoInput.requestMediaDataWhenReady(on: queue) {
          while videoInput.isReadyForMoreMediaData && !finished {
            if FlipControl.shouldStop(jobId) {
              finished = true
              reader.cancelReading()
              writer.cancelWriting()
              end(VideoFlipError.exportFailed("翻转已取消"))
              return
            }
            let sample: CMSampleBuffer
            if let held = pending {
              pending = nil
              sample = held
            } else if let next = videoOutput.copyNextSampleBuffer() {
              sample = next
            } else {
              finished = true
              videoInput.markAsFinished()
              if reader.status == .failed || !wroteVideo {
                end(VideoFlipError.exportFailed(reader.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
                return
              }
              guard let audioInput, let audioTrack, audioHint != nil else {
                writer.finishWriting {
                  if writer.status == .completed {
                    end(nil)
                  } else {
                    end(VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
                  }
                }
                return
              }
              let audioReader: AVAssetReader
              do {
                audioReader = try AVAssetReader(asset: asset)
                FlipControl.track(audioReader)
              } catch {
                writer.finishWriting {
                  if writer.status == .completed {
                    end(nil)
                  } else {
                    end(VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
                  }
                }
                return
              }
              let audioSampleOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
              audioSampleOutput.alwaysCopiesSampleData = true
              guard audioReader.canAdd(audioSampleOutput) else {
                writer.finishWriting {
                  if writer.status == .completed {
                    end(nil)
                  } else {
                    end(VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
                  }
                }
                return
              }
              audioReader.add(audioSampleOutput)
              guard audioReader.startReading() else {
                writer.finishWriting {
                  if writer.status == .completed {
                    end(nil)
                  } else {
                    end(VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
                  }
                }
                return
              }
              audioInput.requestMediaDataWhenReady(on: queue) {
                while audioInput.isReadyForMoreMediaData {
                  if FlipControl.shouldStop(jobId) {
                    finished = true
                    reader.cancelReading()
                    audioReader.cancelReading()
                    writer.cancelWriting()
                    end(VideoFlipError.exportFailed("翻转已取消"))
                    return
                  }
                  guard let audioSample = audioSampleOutput.copyNextSampleBuffer() else {
                    audioInput.markAsFinished()
                    writer.finishWriting {
                      if writer.status == .completed {
                        end(nil)
                      } else {
                        end(VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
                      }
                    }
                    return
                  }
                  let pts = CMSampleBufferGetPresentationTimeStamp(audioSample)
                  if pts.flags.contains(.valid), CMTimeCompare(pts, sessionStart) < 0 {
                    continue
                  }
                  if audioInput.append(audioSample) {
                    continue
                  }
                  audioInput.markAsFinished()
                  writer.finishWriting {
                    if writer.status == .completed {
                      end(nil)
                    } else {
                      end(VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
                    }
                  }
                  return
                }
              }
              return
            }
            if videoInput.append(sample) {
              wroteVideo = true
              continue
            }
            finished = true
            videoInput.markAsFinished()
            end(VideoFlipError.exportFailed(writer.error?.localizedDescription ?? "这个视频的画面时间不连续，系统没法按原样翻转（-11880）"))
            return
          }
        }
      }
    } catch {
      try? FileManager.default.removeItem(at: output)
      throw error
    }
    guard FileManager.default.fileExists(atPath: output.path) else {
      throw VideoFlipError.exportFailed("这个视频的画面时间不连续，系统没法按原样翻转（-11880）")
    }
    return output
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

  static func stageOriginal(_ uri: String) throws -> String {
    let source = try resolveFileURL(uri)
    let accessed = source.startAccessingSecurityScopedResource()
    defer {
      if accessed {
        source.stopAccessingSecurityScopedResource()
      }
    }
    guard FileManager.default.fileExists(atPath: source.path) else {
      throw VideoFlipError.badUri
    }
    let ext = source.pathExtension.isEmpty ? "mp4" : source.pathExtension
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("original-\(UUID().uuidString).\(ext)")
    if FileManager.default.fileExists(atPath: output.path) {
      try? FileManager.default.removeItem(at: output)
    }
    try FileManager.default.copyItem(at: source, to: output)
    return output.absoluteString
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
    let prefixes = ["flipped-", "joined-", "poster-", "frame-", "marked-", "narration-", "smear-", "original-", "face-", "cover-"]
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
