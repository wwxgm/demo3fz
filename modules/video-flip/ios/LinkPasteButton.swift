import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

private final class PasteSink: NSObject, UIPasteConfigurationSupporting {
  var pasteConfiguration: UIPasteConfiguration? = UIPasteConfiguration(acceptableTypeIdentifiers: [
    UTType.plainText.identifier,
    UTType.utf8PlainText.identifier,
    UTType.text.identifier,
    UTType.url.identifier,
  ])
  var onBegin: (() -> Void)?
  var onText: ((String) -> Void)?
  private var progress: Progress?

  func paste(itemProviders: [NSItemProvider]) {
    onBegin?()
    let textTypes: Set<String> = [
      UTType.plainText.identifier,
      UTType.utf8PlainText.identifier,
      UTType.text.identifier,
    ]
    for provider in itemProviders {
      let types = Set(provider.registeredTypeIdentifiers)
      if types.contains(UTType.url.identifier), types.isDisjoint(with: textTypes) {
        progress = provider.loadObject(ofClass: URL.self) { [weak self] object, _ in
          let text = (object as? URL)?.absoluteString ?? ""
          DispatchQueue.main.async {
            self?.onText?(text)
          }
        }
        return
      }
      progress = provider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
        let text = object as? String ?? ""
        DispatchQueue.main.async {
          self?.onText?(text)
        }
      }
      return
    }
  }
}

public class LinkPasteButton: ExpoView {
  let onPaste = EventDispatcher()
  private let sink = PasteSink()
  private var wantsIcon = false
  private var fill = UIColor.systemBlue
  private var ink = UIColor.white
  private var control: UIView?
  private var builtIcon = false
  private var builtFill: UIColor?
  private var builtInk: UIColor?
  private var locked = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    pasteConfiguration = nil
    sink.onBegin = { [weak self] in
      self?.locked = true
    }
    sink.onText = { [weak self] text in
      self?.sendPaste(text)
    }
    rebuild()
  }

  func update(icon: Bool) {
    guard icon != wantsIcon else { return }
    wantsIcon = icon
    rebuild()
  }

  func update(background: UIColor) {
    guard !sameColor(fill, background) else { return }
    fill = background
    rebuild()
  }

  func update(foreground: UIColor) {
    guard !sameColor(ink, foreground) else { return }
    ink = foreground
    rebuild()
  }

  public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard bounds.contains(point), let control else { return nil }
    let converted = control.convert(point, from: self)
    return control.hitTest(converted, with: event) ?? control
  }

  private func rebuild() {
    if locked, control != nil { return }
    if control != nil, builtIcon == wantsIcon, let builtFill, let builtInk, sameColor(builtFill, fill), sameColor(builtInk, ink) {
      return
    }
    control?.removeFromSuperview()
    let view: UIView
    if #available(iOS 16.0, *) {
      let config = UIPasteControl.Configuration()
      config.displayMode = wantsIcon ? .iconOnly : .labelOnly
      config.baseBackgroundColor = fill
      config.baseForegroundColor = ink
      config.cornerRadius = 12
      let button = UIPasteControl(configuration: config)
      button.target = sink
      view = button
    } else {
      let button = UIButton(type: .system)
      button.setTitle(wantsIcon ? "+" : "粘贴", for: .normal)
      button.setTitleColor(ink, for: .normal)
      button.titleLabel?.font = .systemFont(ofSize: wantsIcon ? 26 : 16, weight: .bold)
      button.backgroundColor = fill
      button.layer.cornerRadius = 12
      button.addTarget(self, action: #selector(readClipboard), for: .touchUpInside)
      view = button
    }
    view.translatesAutoresizingMaskIntoConstraints = false
    addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: leadingAnchor),
      view.trailingAnchor.constraint(equalTo: trailingAnchor),
      view.topAnchor.constraint(equalTo: topAnchor),
      view.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    control = view
    builtIcon = wantsIcon
    builtFill = fill
    builtInk = ink
  }

  @objc private func readClipboard() {
    sendPaste(UIPasteboard.general.string ?? "")
  }

  private func sendPaste(_ text: String) {
    let payload: [String: Any] = ["text": text]
    onPaste(payload)
  }

  private func sameColor(_ lhs: UIColor, _ rhs: UIColor) -> Bool {
    if lhs.isEqual(rhs) { return true }
    var lr: CGFloat = 0
    var lg: CGFloat = 0
    var lb: CGFloat = 0
    var la: CGFloat = 0
    var rr: CGFloat = 0
    var rg: CGFloat = 0
    var rb: CGFloat = 0
    var ra: CGFloat = 0
    guard lhs.getRed(&lr, green: &lg, blue: &lb, alpha: &la),
          rhs.getRed(&rr, green: &rg, blue: &rb, alpha: &ra) else {
      return false
    }
    return abs(lr - rr) < 0.01 && abs(lg - rg) < 0.01 && abs(lb - rb) < 0.01 && abs(la - ra) < 0.01
  }
}
