import AVFoundation
import CoreImage

enum LookFilter {
  private static let context = CIContext()

  static func composition(asset: AVAsset, name: String) -> AVVideoComposition {
    AVVideoComposition(asset: asset, applyingCIFiltersWithHandler: { request in
      let source = request.sourceImage
      let output = filtered(source, name: name).cropped(to: source.extent)
      request.finish(with: output, context: context)
    })
  }

  private static func filtered(_ image: CIImage, name: String) -> CIImage {
    switch name {
    case "vivid":
      guard let filter = CIFilter(name: "CIColorControls") else { return image }
      filter.setValue(image, forKey: kCIInputImageKey)
      filter.setValue(1.35, forKey: kCIInputSaturationKey)
      filter.setValue(1.08, forKey: kCIInputContrastKey)
      filter.setValue(0.01, forKey: kCIInputBrightnessKey)
      return filter.outputImage ?? image
    case "warm":
      return temperature(image, target: 4200) ?? image
    case "cool":
      return temperature(image, target: 9000) ?? image
    case "mono":
      guard let filter = CIFilter(name: "CIPhotoEffectMono") else { return image }
      filter.setValue(image, forKey: kCIInputImageKey)
      return filter.outputImage ?? image
    default:
      return image
    }
  }

  private static func temperature(_ image: CIImage, target: CGFloat) -> CIImage? {
    guard let filter = CIFilter(name: "CITemperatureAndTint") else { return nil }
    filter.setValue(image, forKey: kCIInputImageKey)
    filter.setValue(CIVector(x: 6500, y: 0), forKey: "inputNeutral")
    filter.setValue(CIVector(x: target, y: 0), forKey: "inputTargetNeutral")
    return filter.outputImage
  }
}
