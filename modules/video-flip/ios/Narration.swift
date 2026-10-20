import AVFoundation

enum NarrationError: LocalizedError {
  case failed

  var errorDescription: String? {
    "无法生成解说。请到「设置 > 辅助功能 > 朗读内容 > 语音」下载中文语音后再试"
  }
}

actor Narration {
  static let shared = Narration()

  func speak(_ text: String) async throws -> (url: URL, duration: Double) {
    try await NarrationEngine.speak(text)
  }
}

private enum NarrationEngine {
  static func speak(_ text: String) async throws -> (url: URL, duration: Double) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw NarrationError.failed
    }
    guard let voice = chineseMaleVoice() else {
      throw NarrationError.failed
    }
    let utterance = AVSpeechUtterance(string: trimmed)
    utterance.voice = voice
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate
    utterance.pitchMultiplier = 0.92
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

  static func chineseMaleVoice() -> AVSpeechSynthesisVoice? {
    let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("zh") }
    return voices.first { $0.gender == .male && $0.quality == .enhanced }
      ?? voices.first { $0.gender == .male }
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
  private var continuation: CheckedContinuation<(URL, Double), Error>?
  private var file: AVAudioFile?
  private var frames: AVAudioFramePosition = 0
  private var sampleRate: Double = 22050
  private let synth = AVSpeechSynthesizer()
  private let lock = NSLock()
  private var finished = false
  private var onFinish: (() -> Void)?

  init(output: URL, continuation: CheckedContinuation<(URL, Double), Error>) {
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
      completeLocked()
      return
    }
    do {
      if file == nil {
        sampleRate = pcm.format.sampleRate > 0 ? pcm.format.sampleRate : 22050
        file = try AVAudioFile(forWriting: output, settings: pcm.format.settings)
      }
      try file?.write(from: pcm)
      frames += AVAudioFramePosition(pcm.frameLength)
    } catch {
      failLocked(NarrationError.failed)
    }
  }

  private func timeout() {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else {
      return
    }
    synth.stopSpeaking(at: .immediate)
    failLocked(NarrationError.failed)
  }

  private func completeLocked() {
    let duration = sampleRate > 0 ? Double(frames) / sampleRate : 0
    if duration < 0.05 {
      failLocked(NarrationError.failed)
      return
    }
    finished = true
    continuation?.resume(returning: (output, duration))
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
