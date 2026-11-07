import AVFoundation

enum NarrationError: LocalizedError {
  case failed

  var errorDescription: String? {
    "无法生成解说。请到「设置 > 辅助功能 > 朗读内容 > 语音」下载中文语音后再试"
  }
}

actor Narration {
  static let shared = Narration()
  private var busy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func speak(_ text: String, style: String = "steady") async throws -> (url: URL, duration: Double) {
    if busy {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        waiters.append(continuation)
      }
    }
    busy = true
    do {
      let spoken = try await NarrationEngine.speak(text, style: style)
      release()
      return spoken
    } catch {
      release()
      throw error
    }
  }

  private func release() {
    busy = false
    if waiters.isEmpty {
      return
    }
    waiters.removeFirst().resume()
  }
}

private enum NarrationEngine {
  static func speak(_ text: String, style: String) async throws -> (url: URL, duration: Double) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw NarrationError.failed
    }
    let chosen = speechStyle(style)
    guard let voice = chineseVoice(gender: chosen.gender) else {
      throw NarrationError.failed
    }
    let utterance = AVSpeechUtterance(string: trimmed)
    utterance.voice = voice
    utterance.rate = chosen.rate
    utterance.pitchMultiplier = chosen.pitch
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("narration-\(UUID().uuidString).caf")
    return try await withCheckedThrowingContinuation { continuation in
      let writer = NarrationWriter(output: output, continuation: continuation)
      NarrationKeeper.shared.hold(writer)
      writer.start(utterance) {
        NarrationKeeper.shared.release(writer)
      }
    }
  }

  private struct SpeechStyle {
    var gender: AVSpeechSynthesisVoiceGender
    var rate: Float
    var pitch: Float
  }

  private static func speechStyle(_ id: String) -> SpeechStyle {
    let normal = AVSpeechUtteranceDefaultSpeechRate
    switch id {
    case "fast":
      return SpeechStyle(gender: .male, rate: min(normal * 1.22, AVSpeechUtteranceMaximumSpeechRate), pitch: 1.02)
    case "low":
      return SpeechStyle(gender: .male, rate: max(normal * 0.86, AVSpeechUtteranceMinimumSpeechRate), pitch: 0.78)
    case "female":
      return SpeechStyle(gender: .female, rate: normal, pitch: 1.06)
    case "lively":
      return SpeechStyle(gender: .female, rate: min(normal * 1.16, AVSpeechUtteranceMaximumSpeechRate), pitch: 1.16)
    default:
      return SpeechStyle(gender: .male, rate: normal, pitch: 0.92)
    }
  }

  static func chineseVoice(gender: AVSpeechSynthesisVoiceGender) -> AVSpeechSynthesisVoice? {
    let voices = AVSpeechSynthesisVoice.speechVoices().filter { voice in
      voice.language.hasPrefix("zh-CN") || voice.language.hasPrefix("zh-Hans")
    }
    let pool = voices.isEmpty
      ? AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("zh") }
      : voices
    if #available(iOS 16.0, *) {
      if let voice = pool.first(where: { $0.gender == gender && $0.quality == .premium }) {
        return voice
      }
    }
    return pool.first { $0.gender == gender && $0.quality == .enhanced }
      ?? pool.first { $0.gender == gender }
      ?? AVSpeechSynthesisVoice(language: "zh-CN")
  }
}

private final class NarrationKeeper {
  static let shared = NarrationKeeper()
  private var items: [NarrationWriter] = []
  private let lock = NSLock()

  func hold(_ writer: NarrationWriter) {
    lock.lock()
    items.append(writer)
    lock.unlock()
  }

  func release(_ writer: NarrationWriter) {
    lock.lock()
    items.removeAll { $0 === writer }
    lock.unlock()
  }
}

private final class NarrationWriter: NSObject {
  let output: URL
  private var continuation: CheckedContinuation<(url: URL, duration: Double), Error>?
  private var file: AVAudioFile?
  private var frames: AVAudioFramePosition = 0
  private var sampleRate: Double = 22050
  private let synth = AVSpeechSynthesizer()
  private let lock = NSLock()
  private var finished = false
  private var onFinish: (() -> Void)?

  init(output: URL, continuation: CheckedContinuation<(url: URL, duration: Double), Error>) {
    self.output = output
    self.continuation = continuation
  }

  func start(_ utterance: AVSpeechUtterance, done: @escaping () -> Void) {
    onFinish = done
    DispatchQueue.main.async {
      self.synth.write(utterance) { [weak self] buffer in
        self?.consume(buffer)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
      self?.timeout()
    }
  }

  private func consume(_ buffer: AVAudioBuffer) {
    lock.lock()
    defer { lock.unlock() }
    guard !finished, let pcm = buffer as? AVAudioPCMBuffer else {
      return
    }
    if pcm.frameLength == 0 {
      if frames > 0 {
        completeLocked()
      }
      return
    }
    do {
      if file == nil {
        sampleRate = pcm.format.sampleRate > 0 ? pcm.format.sampleRate : 22050
        file = try AVAudioFile(
          forWriting: output,
          settings: pcm.format.settings,
          commonFormat: pcm.format.commonFormat,
          interleaved: pcm.format.isInterleaved
        )
      }
      try file?.write(from: pcm)
      frames += AVAudioFramePosition(pcm.frameLength)
    } catch {
      failLocked(NarrationError.failed)
    }
  }

  private func timeout() {
    lock.lock()
    let already = finished
    lock.unlock()
    if already { return }
    synth.stopSpeaking(at: .immediate)
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return }
    failLocked(NarrationError.failed)
  }

  private func completeLocked() {
    let duration = sampleRate > 0 ? Double(frames) / sampleRate : 0
    if duration < 0.05 {
      failLocked(NarrationError.failed)
      return
    }
    finished = true
    continuation?.resume(returning: (url: output, duration: duration))
    continuation = nil
    scheduleFinish()
  }

  private func failLocked(_ error: Error) {
    guard !finished else {
      return
    }
    finished = true
    continuation?.resume(throwing: error)
    continuation = nil
    scheduleFinish()
  }

  private func scheduleFinish() {
    let done = onFinish
    onFinish = nil
    DispatchQueue.main.async {
      done?()
    }
  }
}
