import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

@available(iOS 16.0, *)
private final class AlwaysPasteControl: UIPasteControl {
  override var isEnabled: Bool {
    get { true }
    set { super.isEnabled = true }
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    super.isEnabled = true
    guard bounds.contains(point) else { return nil }
    return super.hitTest(point, with: event) ?? self
  }
}

public class LinkPasteButton: ExpoView {
  let onPaste = EventDispatcher()
  private var wantsIcon = false
  private var fill = UIColor.systemBlue
  private var ink = UIColor.white
  private var control: UIView?
  private var builtIcon = false
  private var builtFill: UIColor?
  private var builtInk: UIColor?
  private var pasteProgress: Progress?

  private let acceptedTypes = [
    UTType.plainText.identifier,
    UTType.utf8PlainText.identifier,
    UTType.text.identifier,
    UTType.url.identifier,
    UTType.html.identifier,
    UTType.rtf.identifier,
  ]

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: acceptedTypes)
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

  public override func layoutSubviews() {
    super.layoutSubviews()
    (control as? UIControl)?.isEnabled = true
  }

  private func rebuild() {
    if control != nil, builtIcon == wantsIcon, let builtFill, let builtInk, sameColor(builtFill, fill), sameColor(builtInk, ink) {
      (control as? UIControl)?.isEnabled = true
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
      let button = AlwaysPasteControl(configuration: config)
      button.target = self
      button.isEnabled = true
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
    view.isUserInteractionEnabled = true
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

  public override func paste(itemProviders: [NSItemProvider]) {
    let textTypes: Set<String> = [
      UTType.plainText.identifier,
      UTType.utf8PlainText.identifier,
      UTType.text.identifier,
      UTType.html.identifier,
      UTType.rtf.identifier,
    ]
    guard let provider = itemProviders.first else {
      sendPaste("")
      return
    }
    let types = Set(provider.registeredTypeIdentifiers)
    if types.contains(UTType.url.identifier), types.isDisjoint(with: textTypes) {
      pasteProgress = provider.loadObject(ofClass: URL.self) { [weak self] object, _ in
        let text = (object as? URL)?.absoluteString ?? ""
        DispatchQueue.main.async {
          self?.sendPaste(text)
        }
      }
      return
    }
    pasteProgress = provider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
      let text = object as? String ?? ""
      DispatchQueue.main.async {
        self?.sendPaste(text)
      }
    }
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
