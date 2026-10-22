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
    extend: ClipExtend,
    skip: CMTimeRange? = nil
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
      cursor = try appendAround(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        media: media,
        sourceStart: sourceTime(0, base: sourceStart),
        length: seconds(insertAt),
        at: cursor,
        includeAudio: true,
        skip: skip
      )
    }

    let oneFrame = CMTime(value: 20, timescale: 600)
    var freezeStart = CMTimeSubtract(sourceTime(insertAt, base: sourceStart), oneFrame)
    if CMTimeCompare(freezeStart, media.start) < 0 {
      freezeStart = media.start
    }
    if let skip {
      let probe = CMTimeRange(start: freezeStart, duration: oneFrame)
      let hit = probe.intersection(skip)
      if hit.isValid, hit.duration.isValid, hit.duration.seconds > 0.0005 {
        let before = CMTimeSubtract(skip.start, oneFrame)
        if CMTimeCompare(before, media.start) >= 0 {
          freezeStart = before
        } else {
          freezeStart = CMTimeAdd(skip.start, skip.duration)
        }
      }
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
    var replayRange: CMTimeRange?
    let slow = extend.mode == "slow" || extend.mode == "slowZoom"
    if let skip {
      let pieces = parts(start: sourceTime(start, base: sourceStart), length: seconds(end - start), skip: skip)
      guard !pieces.isEmpty else {
        throw ClipTimelineError.message("要延长的这一段正好在移除范围内")
      }
      var inserted = false
      for piece in pieces {
        let at = cursor
        guard let fitted = fit(piece.0, piece.1, media: media) else { continue }
        try compositionVideo.insertTimeRange(fitted, of: video, at: at)
        inserted = true
        if slow {
          let slowed = CMTimeMultiplyByFloat64(fitted.duration, multiplier: 2)
          compositionVideo.scaleTimeRange(CMTimeRange(start: at, duration: fitted.duration), toDuration: slowed)
          cursor = CMTimeAdd(at, slowed)
        } else {
          if let audio, let compositionAudio {
            insertAudio(
              audio,
              compositionAudio: compositionAudio,
              audioSpan: audioSpan,
              sourceStart: fitted.start,
              length: fitted.duration,
              at: at
            )
          }
          cursor = CMTimeAdd(at, fitted.duration)
        }
      }
      guard inserted else {
        throw ClipTimelineError.message("无法插入延长片段")
      }
      if extend.mode == "slowZoom", CMTimeCompare(cursor, replayAt) > 0 {
        replayRange = CMTimeRange(start: replayAt, duration: CMTimeSubtract(cursor, replayAt))
      }
    } else {
      guard let replayPiece = fit(sourceTime(start, base: sourceStart), seconds(end - start), media: media) else {
        throw ClipTimelineError.message("无法插入延长片段")
      }
      try compositionVideo.insertTimeRange(replayPiece, of: video, at: replayAt)
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
    }

    let rest = duration - end
    if rest > 0.05 {
      cursor = try appendAround(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        media: media,
        sourceStart: sourceTime(end, base: sourceStart),
        length: seconds(rest),
        at: cursor,
        includeAudio: true,
        skip: skip
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

  private static func appendAround(
    video: AVAssetTrack,
    audio: AVAssetTrack?,
    compositionVideo: AVMutableCompositionTrack,
    compositionAudio: AVMutableCompositionTrack?,
    audioSpan: CMTimeRange?,
    media: CMTimeRange,
    sourceStart: CMTime,
    length: CMTime,
    at cursor: CMTime,
    includeAudio: Bool,
    skip: CMTimeRange?
  ) throws -> CMTime {
    guard let skip else {
      return try append(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        media: media,
        sourceStart: sourceStart,
        length: length,
        at: cursor,
        includeAudio: includeAudio
      )
    }
    var next = cursor
    for part in parts(start: sourceStart, length: length, skip: skip) {
      next = try append(
        video: video,
        audio: audio,
        compositionVideo: compositionVideo,
        compositionAudio: compositionAudio,
        audioSpan: audioSpan,
        media: media,
        sourceStart: part.0,
        length: part.1,
        at: next,
        includeAudio: includeAudio
      )
    }
    return next
  }

  private static func parts(start: CMTime, length: CMTime, skip: CMTimeRange) -> [(CMTime, CMTime)] {
    let requested = CMTimeRange(start: start, duration: length)
    guard requested.isValid, requested.duration.isValid, requested.duration.seconds > 0.001 else {
      return []
    }
    let hole = skip.intersection(requested)
    guard hole.isValid, hole.duration.isValid, hole.duration.seconds > 0.001 else {
      return [(start, length)]
    }
    var pieces: [(CMTime, CMTime)] = []
    if CMTimeCompare(hole.start, requested.start) > 0 {
      let left = CMTimeSubtract(hole.start, requested.start)
      if left.seconds > 0.001 {
        pieces.append((requested.start, left))
      }
    }
    let holeEnd = CMTimeAdd(hole.start, hole.duration)
    let requestedEnd = CMTimeAdd(requested.start, requested.duration)
    if CMTimeCompare(requestedEnd, holeEnd) > 0 {
      let right = CMTimeSubtract(requestedEnd, holeEnd)
      if right.seconds > 0.001 {
        pieces.append((holeEnd, right))
      }
    }
    return pieces
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
