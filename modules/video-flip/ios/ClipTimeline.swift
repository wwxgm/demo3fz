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

    let insertAt = min(extend.end, duration)
    var cursor = CMTime.zero

    if insertAt > 0.05 {
      cursor = try append(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        sourceStart: sourceTime(0, base: sourceStart),
        length: seconds(insertAt),
        at: cursor,
        includeAudio: true
      )
    }

    let oneFrame = CMTime(value: 1, timescale: 30)
    var freezeStart = CMTimeSubtract(sourceTime(insertAt, base: sourceStart), oneFrame)
    if CMTimeCompare(freezeStart, sourceStart) < 0 {
      freezeStart = sourceStart
    }
    let freezeAt = cursor
    try compositionVideo.insertTimeRange(CMTimeRange(start: freezeStart, duration: oneFrame), of: video, at: freezeAt)
    let freezeDuration = seconds(extend.freeze)
    compositionVideo.scaleTimeRange(CMTimeRange(start: freezeAt, duration: oneFrame), toDuration: freezeDuration)
    cursor = CMTimeAdd(freezeAt, freezeDuration)

    let replayAt = cursor
    let replayLength = seconds(extend.end - extend.start)
    try compositionVideo.insertTimeRange(
      CMTimeRange(start: sourceTime(extend.start, base: sourceStart), duration: replayLength),
      of: video,
      at: replayAt
    )
    var replayRange: CMTimeRange?
    let slow = extend.mode == "slow" || extend.mode == "slowZoom"
    if slow {
      let slowed = CMTimeMultiplyByFloat64(replayLength, multiplier: 2)
      compositionVideo.scaleTimeRange(CMTimeRange(start: replayAt, duration: replayLength), toDuration: slowed)
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
          sourceStart: sourceTime(extend.start, base: sourceStart),
          length: replayLength,
          at: replayAt
        )
      }
      cursor = CMTimeAdd(replayAt, replayLength)
    }

    let rest = duration - insertAt
    if rest > 0.05 {
      cursor = try append(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        sourceStart: sourceTime(insertAt, base: sourceStart),
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
    sourceStart: CMTime,
    length: CMTime,
    at cursor: CMTime,
    includeAudio: Bool
  ) throws -> CMTime {
    try compositionVideo.insertTimeRange(CMTimeRange(start: sourceStart, duration: length), of: video, at: cursor)
    if includeAudio, let audio, let compositionAudio {
      insertAudio(
        audio,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        sourceStart: sourceStart,
        length: length,
        at: cursor
      )
    }
    return CMTimeAdd(cursor, length)
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
