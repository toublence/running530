import Foundation
import AVFoundation
import Capacitor

@objc(MotionFitAudioDuck)
public class MotionFitAudioDuck: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "MotionFitAudioDuck"
  public let jsName = "MotionFitAudioDuck"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "duck", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "unduck", returnType: CAPPluginReturnPromise),
  ]

  private var previousCategory: AVAudioSession.Category?
  private var previousOptions: AVAudioSession.CategoryOptions?
  private var previousActive: Bool = false

  @objc public func duck(_ call: CAPPluginCall) {
    let session = AVAudioSession.sharedInstance()
    previousCategory = session.category
    previousOptions = session.categoryOptions
    previousActive = session.isOtherAudioPlaying

    do {
      try session.setCategory(.playback, options: [.duckOthers, .mixWithOthers, .allowBluetooth, .allowBluetoothA2DP])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      call.resolve(["success": true])
    } catch {
      call.reject("duck failed: \(error.localizedDescription)")
    }
  }

  @objc public func unduck(_ call: CAPPluginCall) {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setActive(false, options: .notifyOthersOnDeactivation)
      if let prevCategory = previousCategory {
        try session.setCategory(prevCategory, options: previousOptions ?? [])
      }
      if previousActive {
        try session.setActive(true, options: .notifyOthersOnDeactivation)
      }
      call.resolve(["success": true])
    } catch {
      call.reject("unduck failed: \(error.localizedDescription)")
    }
  }
}
