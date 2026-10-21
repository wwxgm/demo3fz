import AVFoundation

struct ClipExtend {
  var start: Double
  var end: Double
  var freeze: Double
  var mode: String
}

enum ClipTimelineError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

enum ClipTimeline {
  struct Result {
    let composition: AVMutableComposition
    let videoTrack: AVMutableCompositionTrack
    let audioTrack: AVMutableCompositionTrack?
    let duration: CMTime
    let replayRange: CMTimeRange?
  }

  static func build(
    video: AVAssetTrack,
    audio: AVAssetTrack?,
    sourceStart: CMTime,
    sourceDuration: CMTime,
    extend: ClipExtend
  ) async throws -> Result {
    let duration = sourceDuration.seconds
    let audioSpan: CMTimeRange?
    if let audio {
      audioSpan = try await audio.load(.timeRange)
    } else {
      audioSpan = nil
    }
    guard extend.end > extend.start + 0.2 else {
      throw ClipTimelineError.message("片段结束时间要晚于开始时间")
    }
    guard extend.start >= 0 else {
      throw ClipTimelineError.message("片段开始时间不能小于 0")
    }
    guard extend.end <= duration + 0.08 else {
      throw ClipTimelineError.message("这段视频短于 \(Int(extend.end.rounded(.up))) 秒，无法按这个时间延长")
    }
    guard extend.freeze >= 0.5, extend.freeze <= 30 else {
      throw ClipTimelineError.message("定格请设在 0.5 到 30 秒之间")
    }

    let composition = AVMutableComposition()
    guard let compositionVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw ClipTimelineError.message("无法拼接视频")
    }
    compositionVideo.preferredTransform = .identity
    var compositionAudio: AVMutableCompositionTrack?
    if audio != nil {
      compositionAudio = composition.addMutableTrack(
        withMediaType: .audio,
        preferredTrackID: kCMPersistentTrackID_Invalid
      )
    }

    let end = min(extend.end, duration)
    let start = extend.start
    let insertAt = min(end, duration)
    var cursor = CMTime.zero
    let media = CMTimeRange(start: sourceStart, duration: sourceDuration)

    if insertAt > 0.05 {
      cursor = try append(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        media: media,
        sourceStart: sourceTime(0, base: sourceStart),
        length: seconds(insertAt),
        at: cursor,
        includeAudio: true
      )
    }

    let oneFrame = CMTime(value: 20, timescale: 600)
    var freezeStart = CMTimeSubtract(sourceTime(insertAt, base: sourceStart), oneFrame)
    if CMTimeCompare(freezeStart, media.start) < 0 {
      freezeStart = media.start
    }
    guard let freezePiece = fit(freezeStart, oneFrame, media: media) else {
      throw ClipTimelineError.message("无法截取定格画面")
    }
    let freezeAt = cursor
    try compositionVideo.insertTimeRange(freezePiece, of: video, at: freezeAt)
    let freezeTarget = CMTimeRange(start: freezeAt, duration: freezePiece.duration)
    compositionVideo.scaleTimeRange(freezeTarget, toDuration: seconds(extend.freeze))
    cursor = CMTimeAdd(freezeAt, seconds(extend.freeze))

    let replayAt = cursor
    guard let replayPiece = fit(sourceTime(start, base: sourceStart), seconds(end - start), media: media) else {
      throw ClipTimelineError.message("无法插入延长片段")
    }
    try compositionVideo.insertTimeRange(replayPiece, of: video, at: replayAt)
    var replayRange: CMTimeRange?
    let slow = extend.mode == "slow" || extend.mode == "slowZoom"
    let replayTarget = CMTimeRange(start: replayAt, duration: replayPiece.duration)
    if slow {
      let slowed = CMTimeMultiplyByFloat64(replayPiece.duration, multiplier: 2)
      compositionVideo.scaleTimeRange(replayTarget, toDuration: slowed)
      cursor = CMTimeAdd(replayAt, slowed)
      if extend.mode == "slowZoom" {
        replayRange = CMTimeRange(start: replayAt, duration: slowed)
      }
    } else {
      if let audio, let compositionAudio {
        insertAudio(
          audio,
          compositionAudio: compositionAudio,
          audioSpan: audioSpan,
          sourceStart: replayPiece.start,
          length: replayPiece.duration,
          at: replayAt
        )
      }
      cursor = CMTimeAdd(replayTarget.start, replayTarget.duration)
    }

    let rest = duration - end
    if rest > 0.05 {
      cursor = try append(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        media: media,
        sourceStart: sourceTime(end, base: sourceStart),
        length: seconds(rest),
        at: cursor,
        includeAudio: true
      )
    }

    return Result(
      composition: composition,
      videoTrack: compositionVideo,
      audioTrack: compositionAudio,
      duration: cursor,
      replayRange: replayRange
    )
  }

  private static func append(
    video: AVAssetTrack,
    audio: AVAssetTrack?,
    compositionVideo: AVMutableCompositionTrack,
    compositionAudio: AVMutableCompositionTrack?,
    audioSpan: CMTimeRange?,
    media: CMTimeRange,
    sourceStart: CMTime,
    length: CMTime,
    at cursor: CMTime,
    includeAudio: Bool
  ) throws -> CMTime {
    guard let piece = fit(sourceStart, length, media: media) else {
      return cursor
    }
    try compositionVideo.insertTimeRange(piece, of: video, at: cursor)
    if includeAudio, let audio, let compositionAudio {
      insertAudio(
        audio,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        sourceStart: piece.start,
        length: piece.duration,
        at: cursor
      )
    }
    return CMTimeAdd(cursor, piece.duration)
  }

  private static func fit(_ start: CMTime, _ length: CMTime, media: CMTimeRange) -> CMTimeRange? {
    let piece = CMTimeRange(start: start, duration: length).intersection(media)
    guard piece.isValid, piece.duration.isValid, piece.duration.seconds > 0.001 else {
      return nil
    }
    return piece
  }

  private static func insertAudio(
    _ audio: AVAssetTrack,
    compositionAudio: AVMutableCompositionTrack,
    audioSpan: CMTimeRange?,
    sourceStart: CMTime,
    length: CMTime,
    at cursor: CMTime
  ) {
    guard let available = audioSpan else {
      return
    }
    let requested = CMTimeRange(start: sourceStart, duration: length)
    let piece = requested.intersection(available)
    guard piece.duration.isValid, piece.duration.seconds > 0.02 else {
      return
    }
    let offset = CMTimeSubtract(piece.start, requested.start)
    try? compositionAudio.insertTimeRange(piece, of: audio, at: CMTimeAdd(cursor, offset))
  }

  private static func seconds(_ value: Double) -> CMTime {
    CMTime(seconds: value, preferredTimescale: 600)
  }

  private static func sourceTime(_ secondsValue: Double, base: CMTime) -> CMTime {
    CMTimeAdd(base, seconds(secondsValue))
  }
}
