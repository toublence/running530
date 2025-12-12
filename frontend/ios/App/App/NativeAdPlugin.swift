import Foundation
import UIKit
import Capacitor
import GoogleMobileAds

@objc(NativeAdPlugin)
public class NativeAdPlugin: CAPPlugin, CAPBridgedPlugin, GADNativeAdLoaderDelegate {
  public let identifier = "NativeAdPlugin"
  public let jsName = "NativeAdPlugin"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "loadNativeAd", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "showNativeAd", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "hideNativeAd", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "destroyNativeAd", returnType: CAPPluginReturnPromise),
  ]

  private var adLoader: GADAdLoader?
  private var nativeAd: GADNativeAd?
  private var nativeAdView: GADNativeAdView?
  private var containerView: UIView?
  private var pendingLoadCall: CAPPluginCall?

  public override func load() {
    super.load()
    print("[NativeAdPlugin] load()")
  }

  @objc public func loadNativeAd(_ call: CAPPluginCall) {
    guard let adUnitId = call.getString("adUnitId"), !adUnitId.isEmpty else {
      call.reject("adUnitId is required")
      return
    }

    let request = GADRequest()
    if call.getBool("npa") == true {
      let extras = GADExtras()
      extras.additionalParameters = ["npa": "1"]
      request.register(extras)
    }

    adLoader?.delegate = nil
    adLoader = GADAdLoader(
      adUnitID: adUnitId,
      rootViewController: bridge?.viewController,
      adTypes: [.native],
      options: nil
    )
    adLoader?.delegate = self
    pendingLoadCall = call
    print("[NativeAdPlugin] loading native ad: \(adUnitId)")
    adLoader?.load(request)
  }

  @objc public func showNativeAd(_ call: CAPPluginCall) {
    DispatchQueue.main.async {
      guard let container = self.containerView else {
        call.reject("No ad loaded")
        return
      }

      if container.superview == nil {
        if let webView = self.bridge?.webView, let root = webView.superview {
          root.addSubview(container)
        } else if let vc = self.bridge?.viewController {
          vc.view.addSubview(container)
        }
      }

      container.isHidden = false
      print("[NativeAdPlugin] showNativeAd")
      call.resolve(["success": true])
    }
  }

  @objc public func hideNativeAd(_ call: CAPPluginCall) {
    DispatchQueue.main.async {
      self.containerView?.isHidden = true
      print("[NativeAdPlugin] hideNativeAd")
      call.resolve(["success": true])
    }
  }

  @objc public func destroyNativeAd(_ call: CAPPluginCall) {
    DispatchQueue.main.async {
      self.cleanupAd()
      print("[NativeAdPlugin] destroyNativeAd")
      call.resolve(["success": true])
    }
  }

  private func cleanupAd() {
    nativeAd = nil
    nativeAdView?.removeFromSuperview()
    nativeAdView = nil
    containerView?.removeFromSuperview()
    containerView = nil
  }

  public func adLoader(_ adLoader: GADAdLoader, didFailToReceiveAdWithError error: Error) {
    print("[NativeAdPlugin] failed to load: \(error.localizedDescription)")
    pendingLoadCall?.reject(error.localizedDescription)
    pendingLoadCall = nil
  }

  public func adLoader(_ adLoader: GADAdLoader, didReceive nativeAd: GADNativeAd) {
    self.nativeAd = nativeAd
    print("[NativeAdPlugin] didReceive native ad")
    DispatchQueue.main.async {
      self.buildAdView(for: nativeAd)
    }
    var result = JSObject()
    result["success"] = true
    result["headline"] = nativeAd.headline ?? ""
    pendingLoadCall?.resolve(result)
    pendingLoadCall = nil
  }

  private func buildAdView(for ad: GADNativeAd) {
    cleanupAd()

    guard let vc = bridge?.viewController else { return }
    let rootView = vc.view!
    let safeTop = vc.view.safeAreaInsets.top
    let width = rootView.bounds.width - 32
    let frame = CGRect(x: 16, y: safeTop + 120, width: width, height: 120)

    let container = UIView(frame: frame)
    container.backgroundColor = UIColor.black.withAlphaComponent(0.8)
    container.layer.cornerRadius = 12
    container.clipsToBounds = true
    container.isHidden = true

    let adView = GADNativeAdView(frame: container.bounds)
    adView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    let headline = UILabel(frame: CGRect(x: 12, y: 8, width: container.bounds.width - 24, height: 24))
    headline.textColor = .white
    headline.font = UIFont.boldSystemFont(ofSize: 16)
    headline.text = ad.headline
    adView.headlineView = headline
    adView.addSubview(headline)

    let body = UILabel(frame: CGRect(x: 12, y: 36, width: container.bounds.width - 24, height: 40))
    body.textColor = UIColor(white: 0.9, alpha: 1)
    body.font = UIFont.systemFont(ofSize: 13)
    body.numberOfLines = 2
    body.text = ad.body
    adView.bodyView = body
    adView.addSubview(body)

    let cta = UIButton(type: .system)
    cta.frame = CGRect(x: 12, y: 80, width: 120, height: 28)
    cta.setTitle(ad.callToAction ?? "Learn more", for: .normal)
    cta.setTitleColor(.black, for: .normal)
    cta.backgroundColor = UIColor.systemGreen
    cta.layer.cornerRadius = 14
    adView.callToActionView = cta
    adView.addSubview(cta)

    adView.nativeAd = ad

    container.addSubview(adView)
    if let webView = bridge?.webView, let superview = webView.superview {
      superview.addSubview(container)
    } else {
      rootView.addSubview(container)
    }

    self.nativeAdView = adView
    self.containerView = container
  }
}

