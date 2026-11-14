import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

public class LinkPasteButton: ExpoView {
  let onPaste = EventDispatcher()
  private var wantsIcon = false
  private var fill = UIColor.systemBlue
  private var ink = UIColor.white
  private var control: UIView?
  private var pasteProgress: Progress?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [
      UTType.plainText.identifier,
      UTType.text.identifier,
      UTType.url.identifier,
    ])
    rebuild()
  }

  func update(icon: Bool) {
    guard icon != wantsIcon else { return }
    wantsIcon = icon
    rebuild()
  }

  func update(background: UIColor) {
    fill = background
    rebuild()
  }

  func update(foreground: UIColor) {
    ink = foreground
    rebuild()
  }

  private func rebuild() {
    control?.removeFromSuperview()
    let view: UIView
    if #available(iOS 16.0, *) {
      let config = UIPasteControl.Configuration()
      config.displayMode = wantsIcon ? .iconOnly : .labelOnly
      config.baseBackgroundColor = fill
      config.baseForegroundColor = ink
      config.cornerRadius = 12
      let button = UIPasteControl(configuration: config)
      button.target = self
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
  }

  @objc private func readClipboard() {
    sendPaste(UIPasteboard.general.string ?? "")
  }

  public override func paste(itemProviders: [NSItemProvider]) {
    for provider in itemProviders {
      if provider.canLoadObject(ofClass: NSString.self) {
        pasteProgress = provider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
          let text = object as? String ?? ""
          DispatchQueue.main.async {
            self?.sendPaste(text)
          }
        }
        return
      }
      if provider.canLoadObject(ofClass: URL.self) {
        pasteProgress = provider.loadObject(ofClass: URL.self) { [weak self] object, _ in
          let text = (object as? URL)?.absoluteString ?? ""
          DispatchQueue.main.async {
            self?.sendPaste(text)
          }
        }
        return
      }
    }
  }

  private func sendPaste(_ text: String) {
    let payload: [String: Any] = ["text": text]
    onPaste(payload)
  }
}
